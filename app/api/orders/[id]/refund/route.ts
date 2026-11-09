import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { PayPalError } from "@/lib/paypal/client";
import { recordRefund, refundCapture } from "@/lib/paypal/orders";
import { audit, getNight, getOrder } from "@/lib/repo";
import { requireRosterName } from "@/lib/roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ by: z.string().trim().max(80) });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  const row = getOrder(id);
  if (!row) throw new HttpError(404, "That order was not found.");
  const night = getNight(row.nightId);
  if (!night) throw new HttpError(404, "That order's game was not found.");
  // Sample orders were never sent to PayPal, and the sample season is meant to stay as recorded.
  if (night.sample || id.startsWith("SAMPLE-")) throw new HttpError(409, "Sample games are read-only, so their orders can't be refunded.");
  const by = requireRosterName(body.by, "Whoever is giving the refund");
  if (row.status === "REFUNDED") return ok({ status: "REFUNDED", refundId: row.refundId });
  if (row.status !== "COMPLETED") throw new HttpError(409, "Only a paid order can be refunded.");

  // Refunds stay open after close-out (a fan can ask the next day); recordRefund then
  // files a notice for the officers because the night's expected cash changes.
  let refundId: string;
  if (row.simulated || id.startsWith("SIM-")) {
    // Offline demo orders (SIM-…) only exist here, so there is nothing to refund at PayPal.
    refundId = `SIMREF-${id}`;
  } else {
    if (!row.captureId) throw new HttpError(409, "This order has no PayPal capture to refund.");
    try {
      const refund = await refundCapture(row.captureId, id);
      if (refund.status === "FAILED" || refund.status === "CANCELLED") {
        audit(row.nightId, by, "order.refund_failed", { orderId: id, refundId: refund.id, status: refund.status });
        throw new HttpError(502, `PayPal did not complete the refund (status ${refund.status}).`);
      }
      refundId = refund.id;
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      // Someone already refunded it from the PayPal dashboard.
      if (err.issue === "CAPTURE_FULLY_REFUNDED") {
        refundId = "refunded-in-paypal";
      } else {
        audit(row.nightId, by, "order.refund_failed", { orderId: id, name: err.name, issue: err.issue, debugId: err.debugId });
        throw new HttpError(502, `PayPal could not refund this order: ${err.message}`);
      }
    }
  }

  recordRefund(id, refundId, by);
  return ok({ status: "REFUNDED", refundId });
});
