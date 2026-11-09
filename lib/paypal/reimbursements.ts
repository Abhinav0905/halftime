// Sending supply reimbursements with PayPal Payouts and recording what PayPal
// reports back. Shared by the approve, retry and refresh routes and the webhook.
//
// Each try has its own sender_batch_id: the reimbursement id, then "<id>-2",
// "<id>-3" after a definite failure. PayPal never accepts a sender_batch_id
// twice, so sending the same try again cannot pay twice. That is how a try
// that got no answer from PayPal is settled.

import { paypalConfigured } from "../config";
import { db, nowIso } from "../db";
import { checkApprover } from "../engine/rules";
import { publish } from "../events";
import { HttpError } from "../http";
import {
  audit, findReimbursementByPayout, getClub, getCounts, getNight, getReimbursement, updateReimbursement, type Reimbursement,
} from "../repo";
import { requireRosterName } from "../roster";
import { PAYOUT_UNKNOWN } from "../payout-state";
import { payoutFailed, rejectsEarlierSend, sendPayout, type PayoutOutcome } from "./payouts";
import type { PayPalError } from "./client";

export { PAYOUT_UNKNOWN };

const ATTEMPT = "reimbursement.payout_attempt";

const UNKNOWN_TEXT =
  "PayPal did not answer, so this payout may or may not have gone out. Check with PayPal before doing anything else. It cannot be paid twice.";
const DUPLICATE_TEXT = "PayPal already has this payout, so it was not sent again. Its status will show here once PayPal reports it.";
const unclearText = (err: PayPalError) =>
  `PayPal answered "${err.message}" without saying whether it already has this payout, so it still counts as unconfirmed and cannot be sent as a new payout. ` +
  "Look for it in the club's PayPal account, then use Check with PayPal again.";

export interface PayoutAttempt { attempt: number; senderBatchId: string }

export function senderBatchIdFor(rid: string, attempt: number): string {
  return attempt <= 1 ? rid : `${rid}-${attempt}`;
}

// Tries are recorded in the audit trail, which already says who sent what and when.
/** The most recent try for a reimbursement, or null before the first send. */
export function latestAttempt(r: Pick<Reimbursement, "id" | "nightId">): PayoutAttempt | null {
  const row = db()
    .prepare("SELECT detail FROM audit WHERE night_id = ? AND action = ? AND json_extract(detail, '$.id') = ? ORDER BY id DESC LIMIT 1")
    .get(r.nightId, ATTEMPT, r.id) as { detail: string } | undefined;
  if (!row) return null;
  const d = JSON.parse(row.detail) as PayoutAttempt;
  return { attempt: d.attempt, senderBatchId: d.senderBatchId };
}

function startAttempt(r: Reimbursement, actor: string, attempt: number): PayoutAttempt {
  const senderBatchId = senderBatchIdFor(r.id, attempt);
  audit(r.nightId, actor, ATTEMPT, { id: r.id, attempt, senderBatchId, email: r.payeeEmail, cents: r.cents });
  return { attempt, senderBatchId };
}

function setPayeeEmail(rid: string, email: string): void {
  db().prepare("UPDATE reimbursement SET payee_email = ?, updated_at = ? WHERE id = ?").run(email, nowIso(), rid);
}

// ---------- who may send ----------

function load(rid: string): Reimbursement {
  const r = getReimbursement(rid);
  if (!r) throw new HttpError(404, "That reimbursement was not found.");
  if (getNight(r.nightId)?.sample) throw new HttpError(409, "Sample games are read-only.");
  return r;
}

/** The approver's roster spelling: an officer or the treasurer, not the requester, once the opening count is in. */
function requireApprover(r: Reimbursement, name: string): string {
  const approver = requireRosterName(name, "The approver", ["officer", "treasurer"]);
  const problem = checkApprover(approver, r.requester, getCounts(r.nightId).open !== null);
  if (problem) throw new HttpError(400, problem);
  return approver;
}

// A double-clicked button must not race two requests for one reimbursement:
// PayPal would refuse the second as a duplicate, and recording that refusal
// could overwrite the first one's result.
const inFlight = new Set<string>();

async function locked<T>(rid: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(rid)) throw new HttpError(409, "This payout is already being sent.");
  inFlight.add(rid);
  try {
    return await fn();
  } finally {
    inFlight.delete(rid);
  }
}

// ---------- sending ----------

/**
 * `resend` is true when this try may already have reached PayPal once. A refusal then only marks the
 * reimbursement failed (which unlocks a new try with a new sender_batch_id) if it rules out the first
 * send; otherwise it stays unconfirmed, so it can never be paid twice.
 */
async function send(
  r: Reimbursement, attempt: PayoutAttempt, actor: string, resend: boolean,
): Promise<{ reimbursement: Reimbursement; outcome: PayoutOutcome }> {
  let outcome: PayoutOutcome;
  if (paypalConfigured()) {
    const club = getClub().name;
    outcome = await sendPayout({
      senderBatchId: attempt.senderBatchId,
      senderItemId: r.id,
      email: r.payeeEmail,
      cents: r.cents,
      subject: `Reimbursement from ${club}`,
      note: `${club} reimbursement: ${r.memo}. Approved by ${r.approver ?? actor}.`,
    });
  } else {
    const key = attempt.senderBatchId;
    outcome = { kind: "sent", batchId: `SIM-BATCH-${key}`, itemId: `SIM-ITEM-${key}`, status: "SUCCESS", error: null };
  }

  const ids = { id: r.id, senderBatchId: attempt.senderBatchId };
  switch (outcome.kind) {
    case "sent": {
      const failed = payoutFailed(outcome.status);
      updateReimbursement(r.id, {
        status: failed ? "failed" : "sent",
        batchId: outcome.batchId,
        itemId: outcome.itemId,
        payoutStatus: outcome.status,
        error: failed ? (outcome.error ?? `PayPal reported the payout as ${outcome.status}.`) : null,
      });
      audit(r.nightId, actor, "reimbursement.sent", { ...ids, cents: r.cents, batchId: outcome.batchId, itemId: outcome.itemId, payoutStatus: outcome.status });
      break;
    }
    case "duplicate":
      updateReimbursement(r.id, { status: "requested", payoutStatus: PAYOUT_UNKNOWN, error: DUPLICATE_TEXT });
      audit(r.nightId, actor, "reimbursement.payout_duplicate", ids);
      break;
    case "unknown":
      updateReimbursement(r.id, { status: "requested", payoutStatus: PAYOUT_UNKNOWN, error: UNKNOWN_TEXT });
      audit(r.nightId, actor, "reimbursement.payout_unknown", { ...ids, name: outcome.error.name, debugId: outcome.error.debugId });
      break;
    case "rejected": {
      const err = outcome.error;
      if (resend && !rejectsEarlierSend(err)) {
        updateReimbursement(r.id, { status: "requested", payoutStatus: PAYOUT_UNKNOWN, error: unclearText(err) });
        audit(r.nightId, actor, "reimbursement.payout_unclear", { ...ids, status: err.status, name: err.name, issue: err.issue, debugId: err.debugId });
        outcome = { kind: "unknown", error: err };
        break;
      }
      updateReimbursement(r.id, { status: "failed", payoutStatus: null, error: err.message });
      audit(r.nightId, actor, "reimbursement.failed", { ...ids, name: err.name, issue: err.issue, debugId: err.debugId });
      break;
    }
  }
  publish(r.nightId, { type: "reimbursement.updated", id: r.id });
  return { reimbursement: getReimbursement(r.id)!, outcome };
}

/** First approval. A reimbursement that was already sent comes back as it is, without a second payout. */
export function approvePayout(rid: string, approverName: string) {
  return locked(rid, async () => {
    const r = load(rid);
    if (r.batchId || r.status === "sent") return { reimbursement: r, outcome: null };
    if (r.status === "failed") throw new HttpError(409, "This payout did not go through. Use Try again to send it as a new PayPal payout.");
    if (r.payoutStatus === PAYOUT_UNKNOWN) throw new HttpError(409, "PayPal has not confirmed the earlier try yet. Use Check with PayPal first.");
    const approver = requireApprover(r, approverName);
    updateReimbursement(rid, { approver });
    // A try already on record (the server stopped mid-send) is sent again under the same id, never a new one.
    const earlier = latestAttempt(r);
    const attempt = earlier ?? startAttempt(r, approver, 1);
    return send({ ...r, approver }, attempt, approver, earlier !== null);
  });
}

/**
 * After a definite failure (PayPal refused it, or the payout failed or came back), send it again as a
 * new try with a fresh sender_batch_id, optionally to a corrected email address.
 */
export function retryPayout(rid: string, approverName: string, payeeEmail?: string) {
  return locked(rid, async () => {
    const r = load(rid);
    if (r.status !== "failed") {
      throw new HttpError(409, r.status === "sent" ? "This payout was already sent." : "Only a payout that did not go through can be tried again.");
    }
    const approver = requireApprover(r, approverName);
    const email = payeeEmail?.trim();
    if (email && email !== r.payeeEmail) {
      setPayeeEmail(rid, email);
      audit(r.nightId, approver, "reimbursement.email_changed", { id: rid, from: r.payeeEmail, to: email });
    }
    updateReimbursement(rid, { status: "requested", approver, batchId: null, itemId: null, payoutStatus: null, error: null });
    const fresh = getReimbursement(rid)!;
    const attempt = startAttempt(fresh, approver, (latestAttempt(r)?.attempt ?? 1) + 1);
    return send(fresh, attempt, approver, false);
  });
}

/** Settle a try that got no answer by sending it again under the same sender_batch_id. */
export function settleUnknownPayout(rid: string) {
  return locked(rid, async () => {
    const r = load(rid);
    if (r.payoutStatus !== PAYOUT_UNKNOWN || r.batchId) return { reimbursement: r, outcome: null };
    const attempt = latestAttempt(r) ?? { attempt: 1, senderBatchId: r.id };
    return send(r, attempt, r.approver ?? "Halftime", true);
  });
}

// ---------- status reports from PayPal ----------

/**
 * The reimbursement a payout report is about. Before the batch id is stored (no answer to the
 * create call, or approve still waiting for the item) it is found by sender_item_id, which is
 * always the reimbursement id. A report for an earlier try that failed is not matched.
 */
export function reimbursementForPayout(ids: {
  batchId: string | null; itemId: string | null; senderBatchId: string | null; senderItemId: string | null;
}): Reimbursement | null {
  const known = findReimbursementByPayout({ batchId: ids.batchId, itemId: ids.itemId });
  if (known) return known;
  const rid = ids.senderItemId ?? ids.senderBatchId;
  const r = rid ? getReimbursement(rid) : null;
  if (!r || r.batchId) return null;
  const current = latestAttempt(r)?.senderBatchId ?? r.id;
  return ids.senderBatchId === null || ids.senderBatchId === current ? r : null;
}

/** Store the item status PayPal reported for the current try. Returns true if anything changed. */
export function recordPayoutStatus(
  r: Reimbursement,
  report: { status: string; batchId: string | null; itemId: string | null; error: string | null },
  actor: string | null,
): boolean {
  const failed = payoutFailed(report.status);
  const next = {
    // A report about the item means PayPal accepted the payout.
    status: failed ? ("failed" as const) : ("sent" as const),
    batchId: r.batchId ?? report.batchId,
    itemId: report.itemId ?? r.itemId,
    payoutStatus: report.status,
    error: failed ? (report.error ?? `PayPal reported the payout as ${report.status}.`) : null,
  };
  if (next.status === r.status && next.batchId === r.batchId && next.itemId === r.itemId && next.payoutStatus === r.payoutStatus && next.error === r.error) {
    return false;
  }
  updateReimbursement(r.id, next);
  audit(r.nightId, actor, "reimbursement.payout_status", { id: r.id, payoutStatus: report.status, batchId: next.batchId, itemId: next.itemId });
  publish(r.nightId, { type: "reimbursement.updated", id: r.id });
  return true;
}
