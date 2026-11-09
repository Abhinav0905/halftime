import { z } from "zod";
import { publish } from "@/lib/events";
import { HttpError, MAX_JSON_BYTES, handle, ok, readBody } from "@/lib/http";
import { PayPalError, outcomeUnknown } from "@/lib/paypal/client";
import { captureOrder, getOrder as getPayPalOrder, recordCapture, type PayPalOrderView } from "@/lib/paypal/orders";
import { audit, getNight, getOrder, markOrderDeclined, type OrderRow } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ mockDecline: z.boolean().optional() });

const ACTOR = "buyer";

const UNCONFIRMED = "PayPal has not confirmed this payment yet. Please don't pay again.";

// The buyer button may post with no body at all.
async function readCaptureBody(req: Request): Promise<z.infer<typeof Body>> {
  const text = new TextDecoder().decode(await readBody(req, MAX_JSON_BYTES));
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

/** Ask PayPal what happened to an order whose capture call gave no clear answer. */
async function readBack(row: OrderRow): Promise<PayPalOrderView> {
  try {
    return await getPayPalOrder(row.id);
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    audit(row.nightId, ACTOR, "order.get_failed", { orderId: row.id, issue: err.issue, debugId: err.debugId });
    throw new HttpError(502, UNCONFIRMED);
  }
}

function pending(row: OrderRow, captureStatus: string | null): Response {
  // PayPal is holding the payment for review. The PAYMENT.CAPTURE.COMPLETED webhook finishes it later.
  audit(row.nightId, ACTOR, "order.capture_pending", { orderId: row.id, captureStatus });
  return ok({ status: "PENDING", code: row.code }, 202);
}

function unexpected(row: OrderRow, captureStatus: string): never {
  // REFUNDED or PARTIALLY_REFUNDED before we ever saw it complete. The refund webhook brings our record in line.
  audit(row.nightId, ACTOR, "order.capture_unexpected", { orderId: row.id, captureStatus });
  throw new HttpError(409, `PayPal reports this payment as ${captureStatus.toLowerCase().replace(/_/g, " ")}. Please show code ${row.code} at the window.`);
}

/**
 * Selling has ended, so no new capture is started: it would land on stock already counted as left over.
 * An earlier try may still have gone through with its answer lost, so PayPal is asked before the buyer
 * is told they were not charged. recordCapture files the late-capture notice for the officers.
 */
async function afterSelling(row: OrderRow, nightStatus: string | null): Promise<Response> {
  if (!row.simulated) {
    const view = await readBack(row);
    if (view.captureStatus === "COMPLETED") {
      recordCapture(row.id, view, ACTOR);
      return paid(getOrder(row.id)!);
    }
    if (view.captureStatus === "PENDING") return pending(row, view.captureStatus);
    if (view.captureStatus === "REFUNDED" || view.captureStatus === "PARTIALLY_REFUNDED") unexpected(row, view.captureStatus);
  }
  audit(row.nightId, ACTOR, "order.capture_refused", { orderId: row.id, code: row.code, nightStatus });
  return ok({ error: "The stand stopped taking orders before this payment went through, so you were not charged.", reason: "STAND_CLOSED" }, 409);
}

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readCaptureBody(req);
  const row = getOrder(id);
  if (!row) throw new HttpError(404, "That order was not found.");
  if (row.status === "COMPLETED") return paid(row);
  if (row.status === "REFUNDED") throw new HttpError(409, "This order was refunded.");

  const night = getNight(row.nightId);
  if (!night || night.status !== "selling") return afterSelling(row, night?.status ?? null);

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
  let readFromPayPal = false;
  try {
    captured = await captureOrder(id, { mockDecline: body.mockDecline });
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    if (err.issue === "INSTRUMENT_DECLINED") return declined(row, err.issue);
    if (err.issue === "ORDER_NOT_APPROVED") throw new HttpError(409, "The buyer has not approved this payment yet.");
    const unknown = outcomeUnknown(err);
    if (err.issue !== "ORDER_ALREADY_CAPTURED" && !unknown) {
      audit(row.nightId, ACTOR, "order.capture_failed", { orderId: id, name: err.name, issue: err.issue, debugId: err.debugId });
      throw new HttpError(422, `PayPal could not complete the payment, so nothing was charged: ${err.message}`);
    }
    // Either it was captured already, or we got no answer and PayPal may have taken the money.
    if (unknown) audit(row.nightId, ACTOR, "order.capture_unconfirmed", { orderId: id, name: err.name, debugId: err.debugId });
    captured = await readBack(row);
    readFromPayPal = true;
    // No capture on the order yet. Capturing again is safe: PayPal-Request-Id capture-<id> stops a second charge.
    if (!captured.captureStatus) throw new HttpError(502, UNCONFIRMED);
  }
  if (captured.captureStatus === "DECLINED" || captured.captureStatus === "FAILED") {
    return declined(row, `CAPTURE_${captured.captureStatus}`);
  }

  // GET order is the record we keep: PayPal's own line items and total, never the browser's.
  let truth = captured;
  if (!readFromPayPal) {
    try {
      truth = await getPayPalOrder(id);
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      audit(row.nightId, ACTOR, "order.get_failed", { orderId: id, issue: err.issue, debugId: err.debugId });
    }
  }
  const captureStatus = truth.captureStatus ?? captured.captureStatus;
  if (captureStatus === "COMPLETED") {
    recordCapture(id, { ...truth, captureId: truth.captureId ?? captured.captureId }, ACTOR);
    return paid(getOrder(id)!);
  }
  if (captureStatus === "PENDING" || captureStatus === null) return pending(row, captureStatus);
  unexpected(row, captureStatus);
});
