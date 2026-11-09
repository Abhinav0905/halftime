// Payouts v1 for supply reimbursements. The server SDK does not cover Payouts,
// so these calls use the typed REST helper.

import { centsToValue } from "../money";
import { PayPalError, outcomeUnknown, paypalFetch } from "./client";

interface PayoutItemBody {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status?: string;
  payout_batch_id: string;
  errors?: { name?: string; message?: string };
}

interface PayoutBatchBody {
  batch_header: { payout_batch_id: string; batch_status: string };
  items?: PayoutItemBody[];
}

export interface PayoutItem {
  itemId: string;
  batchId: string;
  status: string;
  transactionId: string | null;
  error: string | null;
}

/** What happened to one create-payout request. Only "rejected" means PayPal definitely did not take it. */
export type PayoutOutcome =
  /** status is the item status once PayPal has created the item (UNCLAIMED, SUCCESS, ...), otherwise the batch status. */
  | { kind: "sent"; batchId: string; itemId: string | null; status: string; error: string | null }
  /** PayPal already holds a batch with this sender_batch_id but did not say which one. */
  | { kind: "duplicate" }
  /** No answer (timeout, dropped connection, 5xx): PayPal may or may not have accepted it. */
  | { kind: "unknown"; error: PayPalError }
  | { kind: "rejected"; error: PayPalError };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toItem(i: PayoutItemBody): PayoutItem {
  return {
    itemId: i.payout_item_id,
    batchId: i.payout_batch_id,
    status: i.transaction_status ?? "PENDING",
    transactionId: i.transaction_id ?? null,
    error: i.errors?.message ?? i.errors?.name ?? null,
  };
}

/** PayPal's answer when a sender_batch_id was used before: "Batch with given sender_batch_id already exists". */
export function isDuplicateBatch(err: PayPalError): boolean {
  if (err.status < 400 || err.status >= 500) return false;
  const text = `${err.issue ?? ""} ${err.message}`;
  return /sender_batch_id/i.test(text) && /already|duplicate|exists/i.test(text);
}

// PayPal's names for a request body it could not accept. The body of a re-sent try is the same as the
// first send, so the first send was refused for the same reason.
const INVALID_REQUEST = new Set(["VALIDATION_ERROR", "INVALID_REQUEST", "MALFORMED_REQUEST"]);

/**
 * True when PayPal's refusal of a re-sent try also rules out the first send having gone through.
 * Anything else (a duplicate message worded in a way we don't recognise, a business rule, a rate
 * limit, an auth problem) could still come back for a payout PayPal already holds.
 */
export function rejectsEarlierSend(err: PayPalError): boolean {
  return err.status === 400 && INVALID_REQUEST.has(err.name);
}

/** The existing batch id from a duplicate error's link (.../v1/payments/payouts/{batch id}), if PayPal sent one. */
export function batchIdFromLinks(links: string[]): string | null {
  for (const href of links) {
    const m = /\/v1\/payments\/payouts\/([^/?#]+)/.exec(href);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/** The batch and its item as they stand now. The create response never includes the item; PayPal usually has it a moment later. */
async function sentOutcome(batchId: string, fallbackStatus: string, waits: number[]): Promise<PayoutOutcome> {
  for (const wait of waits) {
    if (wait) await sleep(wait);
    const batch = await getPayoutBatch(batchId).catch(() => null);
    const item = batch?.items[0];
    if (item) return { kind: "sent", batchId, itemId: item.itemId, status: item.status, error: item.error };
    if (batch) fallbackStatus = batch.status;
  }
  return { kind: "sent", batchId, itemId: null, status: fallbackStatus, error: null };
}

/**
 * One payout to one email. PayPal refuses a second batch with the same
 * sender_batch_id, so sending the same attempt again can never pay twice; that
 * is also how an attempt with no answer gets resolved. sender_item_id is always
 * the reimbursement id, so payout webhooks can be matched to it.
 */
export async function sendPayout(input: {
  senderBatchId: string; senderItemId: string; email: string; cents: number; note: string; subject?: string;
}): Promise<PayoutOutcome> {
  let created: PayoutBatchBody;
  try {
    created = await paypalFetch<PayoutBatchBody>("/v1/payments/payouts", {
      body: {
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          recipient_type: "EMAIL",
          email_subject: input.subject ?? "You have a reimbursement",
          email_message: input.note.slice(0, 1000),
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: input.email,
            amount: { value: centsToValue(input.cents), currency: "USD" },
            note: input.note.slice(0, 4000),
            sender_item_id: input.senderItemId,
          },
        ],
      },
    });
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    if (isDuplicateBatch(err)) {
      const existing = batchIdFromLinks(err.links);
      return existing ? sentOutcome(existing, "PENDING", [0]) : { kind: "duplicate" };
    }
    return outcomeUnknown(err) ? { kind: "unknown", error: err } : { kind: "rejected", error: err };
  }
  return sentOutcome(created.batch_header.payout_batch_id, created.batch_header.batch_status, [0, 1500]);
}

export async function getPayoutItem(itemId: string): Promise<PayoutItem> {
  return toItem(await paypalFetch<PayoutItemBody>(`/v1/payments/payouts-item/${encodeURIComponent(itemId)}`));
}

export async function getPayoutBatch(batchId: string): Promise<{ batchId: string; status: string; items: PayoutItem[] }> {
  const body = await paypalFetch<PayoutBatchBody>(`/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  return { batchId: body.batch_header.payout_batch_id, status: body.batch_header.batch_status, items: (body.items ?? []).map(toItem) };
}

/** Item statuses after which the money will not reach the payee without a new payout. */
export function payoutFailed(status: string | null | undefined): boolean {
  return status === "FAILED" || status === "RETURNED" || status === "BLOCKED" || status === "DENIED" || status === "REFUNDED" || status === "REVERSED";
}
