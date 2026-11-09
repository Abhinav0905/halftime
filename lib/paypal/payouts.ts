// Payouts v1 for supply reimbursements. The server SDK does not cover Payouts,
// so these calls use the typed REST helper.

import { centsToValue } from "../money";
import { paypalFetch } from "./client";

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

export interface PayoutResult {
  batchId: string;
  itemId: string | null;
  /** Item status when PayPal has created the item yet (UNCLAIMED, SUCCESS, ...), otherwise the batch status. */
  status: string;
}

export interface PayoutItem {
  itemId: string;
  batchId: string;
  status: string;
  transactionId: string | null;
  error: string | null;
}

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

/**
 * One payout to one email. sender_batch_id is the reimbursement id, and PayPal
 * refuses a second batch with the same id, so a repeated approval cannot pay twice.
 */
export async function sendPayout(input: { senderBatchId: string; email: string; cents: number; note: string; subject?: string }): Promise<PayoutResult> {
  const created = await paypalFetch<PayoutBatchBody>("/v1/payments/payouts", {
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
          sender_item_id: input.senderBatchId,
        },
      ],
    },
  });
  const batchId = created.batch_header.payout_batch_id;

  // The create response never includes the item. PayPal usually has it a moment later.
  for (const wait of [0, 1500]) {
    if (wait) await sleep(wait);
    const batch = await getPayoutBatch(batchId).catch(() => null);
    const item = batch?.items[0];
    if (item) return { batchId, itemId: item.itemId, status: item.status };
  }
  return { batchId, itemId: null, status: created.batch_header.batch_status };
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
