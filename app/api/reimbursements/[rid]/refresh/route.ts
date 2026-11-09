import { HttpError, handle, ok } from "@/lib/http";
import { PayPalError, outcomeUnknown } from "@/lib/paypal/client";
import { getPayoutBatch, getPayoutItem, type PayoutItem } from "@/lib/paypal/payouts";
import { PAYOUT_UNKNOWN, recordPayoutStatus, settleUnknownPayout } from "@/lib/paypal/reimbursements";
import { getReimbursement } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ rid: string }> }) => {
  const { rid } = await ctx.params;
  const r = getReimbursement(rid);
  if (!r) throw new HttpError(404, "That reimbursement was not found.");

  if (!r.batchId) {
    if (r.payoutStatus !== PAYOUT_UNKNOWN) throw new HttpError(409, "This reimbursement has not been sent yet.");
    // No batch id because PayPal never answered the create call. Sending the same try again either
    // finds PayPal's batch or sends it now; either way it is paid at most once.
    const { reimbursement: now, outcome } = await settleUnknownPayout(rid);
    if (outcome?.kind === "unknown") {
      if (outcomeUnknown(outcome.error)) throw new HttpError(503, "PayPal still did not answer. Please try again in a minute.");
      // PayPal answered, but not in a way that says whether the first send went through. It stays unconfirmed.
      throw new HttpError(502, now.error ?? `PayPal answered: ${outcome.error.message}`);
    }
    if (outcome?.kind === "rejected") throw new HttpError(502, `PayPal did not accept the payout: ${outcome.error.message}`);
    return ok({ status: now.status, payoutStatus: now.payoutStatus });
  }
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
  if (payoutStatus) {
    recordPayoutStatus(r, { status: payoutStatus, batchId: r.batchId, itemId: item?.itemId ?? null, error: item?.error ?? null }, null);
  }
  const now = getReimbursement(rid)!;
  return ok({ status: now.status, payoutStatus: now.payoutStatus });
});
