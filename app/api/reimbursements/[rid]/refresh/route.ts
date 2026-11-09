import { publish } from "@/lib/events";
import { HttpError, handle, ok } from "@/lib/http";
import { PayPalError } from "@/lib/paypal/client";
import { getPayoutBatch, getPayoutItem, payoutFailed, type PayoutItem } from "@/lib/paypal/payouts";
import { audit, getReimbursement, updateReimbursement } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ rid: string }> }) => {
  const { rid } = await ctx.params;
  const r = getReimbursement(rid);
  if (!r) throw new HttpError(404, "That reimbursement was not found.");
  if (!r.batchId) throw new HttpError(409, "This reimbursement has not been sent yet.");
  if (r.batchId.startsWith("SIM-")) return ok({ status: r.status, payoutStatus: r.payoutStatus });

  let item: PayoutItem | null;
  let batchStatus: string | null = null;
  try {
    if (r.itemId) {
      item = await getPayoutItem(r.itemId);
    } else {
      const batch = await getPayoutBatch(r.batchId);
      item = batch.items[0] ?? null;
      batchStatus = batch.status;
    }
  } catch (err) {
    if (err instanceof PayPalError) throw new HttpError(502, `Could not get the payout status from PayPal: ${err.message}`);
    throw err;
  }

  const payoutStatus = item?.status ?? batchStatus ?? r.payoutStatus;
  const failed = payoutFailed(payoutStatus);
  if (payoutStatus !== r.payoutStatus || (item && item.itemId !== r.itemId) || (failed && r.status !== "failed")) {
    updateReimbursement(rid, {
      payoutStatus,
      itemId: item?.itemId ?? r.itemId,
      ...(failed ? { status: "failed" as const, error: item?.error ?? `PayPal reported the payout as ${payoutStatus}.` } : {}),
    });
    audit(r.nightId, null, "reimbursement.payout_status", { id: rid, payoutStatus, itemId: item?.itemId ?? r.itemId });
    publish(r.nightId, { type: "reimbursement.updated", id: rid });
  }
  const now = getReimbursement(rid)!;
  return ok({ status: now.status, payoutStatus: now.payoutStatus });
});
