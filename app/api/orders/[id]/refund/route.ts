import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { PayPalError } from "@/lib/paypal/client";
import { recordRefund, refundCapture } from "@/lib/paypal/orders";
import { audit, getOrder } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ by: z.string().trim().min(1, "Enter who is giving the refund.").max(80) });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  const row = getOrder(id);
  if (!row) throw new HttpError(404, "That order was not found.");
  if (row.status === "REFUNDED") return ok({ status: "REFUNDED", refundId: row.refundId });
  if (row.status !== "COMPLETED") throw new HttpError(409, "Only a paid order can be refunded.");

  let refundId: string;
  if (row.simulated) {
    refundId = `SIMREF-${id}`;
  } else {
    if (!row.captureId) throw new HttpError(409, "This order has no PayPal capture to refund.");
    try {
      const refund = await refundCapture(row.captureId, id);
      if (refund.status === "FAILED" || refund.status === "CANCELLED") {
        audit(row.nightId, body.by, "order.refund_failed", { orderId: id, refundId: refund.id, status: refund.status });
        throw new HttpError(502, `PayPal did not complete the refund (status ${refund.status}).`);
      }
      refundId = refund.id;
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      // Someone already refunded it from the PayPal dashboard.
      if (err.issue === "CAPTURE_FULLY_REFUNDED") {
        refundId = "refunded-in-paypal";
      } else {
        audit(row.nightId, body.by, "order.refund_failed", { orderId: id, name: err.name, issue: err.issue, debugId: err.debugId });
        throw new HttpError(502, `PayPal could not refund this order: ${err.message}`);
      }
    }
  }

  recordRefund(id, refundId, body.by);
  return ok({ status: "REFUNDED", refundId });
});
