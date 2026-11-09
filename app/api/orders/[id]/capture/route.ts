import { z } from "zod";
import { publish } from "@/lib/events";
import { HttpError, handle, ok } from "@/lib/http";
import { PayPalError } from "@/lib/paypal/client";
import { captureOrder, getOrder as getPayPalOrder, recordCapture, type PayPalOrderView } from "@/lib/paypal/orders";
import { audit, getOrder, markOrderDeclined, type OrderRow } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ mockDecline: z.boolean().optional() });

const ACTOR = "buyer";

// The buyer button may post with no body at all.
async function readBody(req: Request): Promise<z.infer<typeof Body>> {
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Expected a JSON body.");
    }
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "mockDecline must be true or false.");
  return parsed.data;
}

function paid(row: OrderRow): Response {
  return ok({ status: "COMPLETED", code: row.code, items: row.items, totalCents: row.totalCents });
}

/** 402 lets the buyer button call actions.restart() and offer another way to pay. */
function declined(row: OrderRow, issue: string): Response {
  markOrderDeclined(row.id, issue);
  audit(row.nightId, ACTOR, "order.declined", { orderId: row.id, code: row.code, issue });
  publish(row.nightId, { type: "order.declined", orderId: row.id, code: row.code, reason: issue });
  return ok({ status: "DECLINED", issue, code: row.code }, 402);
}

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readBody(req);
  const row = getOrder(id);
  if (!row) throw new HttpError(404, "That order was not found.");
  if (row.status === "COMPLETED") return paid(row);
  if (row.status === "REFUNDED") throw new HttpError(409, "This order was refunded.");

  if (row.simulated) {
    if (body.mockDecline) return declined(row, "INSTRUMENT_DECLINED");
    recordCapture(id, {
      id, status: "COMPLETED", referenceId: row.nightId, customId: null, invoiceId: null,
      items: row.items, totalCents: row.totalCents,
      captureId: `SIMCAP-${id}`, captureStatus: "COMPLETED", captureCents: row.totalCents,
      payer: "offline demo", funding: "paypal",
    }, ACTOR);
    return paid(getOrder(id)!);
  }

  let captured: PayPalOrderView;
  try {
    captured = await captureOrder(id, { mockDecline: body.mockDecline });
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    if (err.issue === "INSTRUMENT_DECLINED") return declined(row, err.issue);
    if (err.issue === "ORDER_ALREADY_CAPTURED") {
      captured = await getPayPalOrder(id);
    } else if (err.issue === "ORDER_NOT_APPROVED") {
      throw new HttpError(409, "The buyer has not approved this payment yet.");
    } else {
      audit(row.nightId, ACTOR, "order.capture_failed", { orderId: id, name: err.name, issue: err.issue, debugId: err.debugId });
      throw new HttpError(502, `PayPal could not complete the payment: ${err.message}`);
    }
  }
  if (captured.captureStatus === "DECLINED" || captured.captureStatus === "FAILED") {
    return declined(row, `CAPTURE_${captured.captureStatus}`);
  }

  // GET order is the record we keep: PayPal's own line items and total, never the browser's.
  let truth: PayPalOrderView;
  try {
    truth = await getPayPalOrder(id);
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    audit(row.nightId, ACTOR, "order.get_failed", { orderId: id, issue: err.issue, debugId: err.debugId });
    truth = captured;
  }
  const captureStatus = truth.captureStatus ?? captured.captureStatus;
  if (captureStatus !== "COMPLETED") {
    // e.g. PENDING under review. The PAYMENT.CAPTURE.COMPLETED webhook finishes it later.
    audit(row.nightId, ACTOR, "order.capture_pending", { orderId: id, captureStatus });
    return ok({ status: captureStatus ?? "PENDING", code: row.code }, 202);
  }
  recordCapture(id, { ...truth, captureId: truth.captureId ?? captured.captureId }, ACTOR);
  return paid(getOrder(id)!);
});
