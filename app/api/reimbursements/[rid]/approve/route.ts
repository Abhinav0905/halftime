import { z } from "zod";
import { paypalConfigured } from "@/lib/config";
import { checkApprover } from "@/lib/engine/rules";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { PayPalError } from "@/lib/paypal/client";
import { sendPayout, type PayoutResult } from "@/lib/paypal/payouts";
import { audit, getClub, getCounts, getReimbursement, updateReimbursement } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ approver: z.string().trim().max(80) });

// A double-clicked Approve must not race two payout requests. PayPal would
// reject the second (same sender_batch_id), and that error would overwrite the
// first request's success.
const inFlight = new Set<string>();

export const POST = handle(async (req: Request, ctx: { params: Promise<{ rid: string }> }) => {
  const { rid } = await ctx.params;
  const body = await readJson(req, Body);
  const r = getReimbursement(rid);
  if (!r) throw new HttpError(404, "That reimbursement was not found.");
  if (r.batchId) return ok({ status: r.status, payoutStatus: r.payoutStatus, batchId: r.batchId });

  const problem = checkApprover(body.approver, r.requester, getCounts(r.nightId).open !== null);
  if (problem) throw new HttpError(400, problem);
  if (inFlight.has(rid)) throw new HttpError(409, "This payout is already being sent.");

  inFlight.add(rid);
  let payout: PayoutResult;
  try {
    updateReimbursement(rid, { approver: body.approver });
    if (paypalConfigured()) {
      const club = getClub().name;
      payout = await sendPayout({
        senderBatchId: rid,
        email: r.payeeEmail,
        cents: r.cents,
        subject: `Reimbursement from ${club}`,
        note: `${club} reimbursement: ${r.memo}. Approved by ${body.approver}.`,
      });
    } else {
      payout = { batchId: `SIM-BATCH-${rid}`, itemId: `SIM-ITEM-${rid}`, status: "SUCCESS" };
    }
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    updateReimbursement(rid, { status: "failed", error: err.message });
    audit(r.nightId, body.approver, "reimbursement.failed", { id: rid, name: err.name, issue: err.issue, debugId: err.debugId });
    publish(r.nightId, { type: "reimbursement.updated", id: rid });
    throw new HttpError(502, `PayPal did not accept the payout: ${err.message}`);
  } finally {
    inFlight.delete(rid);
  }

  updateReimbursement(rid, { status: "sent", batchId: payout.batchId, itemId: payout.itemId, payoutStatus: payout.status, error: null });
  audit(r.nightId, body.approver, "reimbursement.sent", { id: rid, cents: r.cents, batchId: payout.batchId, itemId: payout.itemId, payoutStatus: payout.status });
  publish(r.nightId, { type: "reimbursement.updated", id: rid });
  return ok({ status: "sent", payoutStatus: payout.status, batchId: payout.batchId });
});
