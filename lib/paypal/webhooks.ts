// PayPal webhooks. They back up the synchronous capture/refund paths and carry
// payout results. PayPal re-sends any event that does not get a 2xx, for up to
// three days. So only events whose signature verifies are stored; each event id
// is applied at most once; and an event that cannot be applied yet (PayPal
// could not be reached, or it arrived before the event it depends on) throws,
// so the route answers 5xx and PayPal tries again later.

import { paypalConfig, paypalConfigured } from "../config";
import { publish } from "../events";
import { valueToCents } from "../money";
import { partialRefundNotice } from "../notice-text";
import {
  addNotice, audit, deleteWebhookEvent, getNight, getOrder as getOrderRow, getOrderByCaptureId, insertWebhookEvent, markOrderDeclined,
  type OrderRow,
} from "../repo";
import { PayPalError, outcomeUnknown, paypalFetch } from "./client";
import {
  getCapture as getPayPalCapture, getOrder as getPayPalOrder, recordCapture, recordRefund, type CaptureView, type PayPalOrderView,
} from "./orders";
import { recordPayoutStatus, reimbursementForPayout } from "./reimbursements";

const ACTOR = "PayPal webhook";

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  summary?: string;
  create_time?: string;
  resource?: Record<string, unknown>;
}

export interface WebhookDeps {
  verify: (headers: Headers, rawBody: string) => Promise<boolean>;
  getOrder: (orderId: string) => Promise<PayPalOrderView>;
  getCapture: (captureId: string) => Promise<CaptureView>;
}

export const defaultDeps: WebhookDeps = {
  verify: (headers, rawBody) => verifyWebhook(headers, rawBody),
  getOrder: (orderId) => getPayPalOrder(orderId),
  getCapture: (captureId) => getPayPalCapture(captureId),
};

export type WebhookOutcome =
  | { result: "applied"; detail: string }
  | { result: "ignored"; detail: string }
  | { result: "duplicate" }
  | { result: "unverified" };

/** The signature could not be checked because PayPal did not answer. The event is not stored, so PayPal's retry gets through. */
export class VerificationUnavailable extends Error {}

/** The event refers to something we have not recorded yet. Answering 5xx makes PayPal send it again later. */
export class NotReadyYet extends Error {}

// ---------- signature verification ----------

/** PayPal signs with certificates it serves from its own API hosts, e.g. api.sandbox.paypal.com. */
function isPayPalCertUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

/** True for SUCCESS, false for anything that is not a genuine signature. Throws VerificationUnavailable if PayPal could not be asked. */
export async function verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
  const { webhookId } = paypalConfig();
  if (!webhookId || !paypalConfigured()) return false;
  const fields = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
  };
  // Checked here first so a forged request does not cost a call to PayPal.
  if (Object.values(fields).some((v) => !v) || !isPayPalCertUrl(fields.cert_url!)) return false;
  // Splice in the body exactly as received. Re-serializing the parsed event can
  // change number formatting or escapes, and then PayPal reports FAILURE.
  const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
  try {
    const res = await paypalFetch<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", { rawBody: body });
    return res.verification_status === "SUCCESS";
  } catch (err) {
    if (err instanceof PayPalError && !outcomeUnknown(err)) return false;
    throw new VerificationUnavailable(err instanceof Error ? err.message : String(err));
  }
}

// ---------- receiving ----------

function parseEvent(rawBody: string): WebhookEvent {
  const event = JSON.parse(rawBody) as WebhookEvent;
  if (!event || typeof event.id !== "string" || typeof event.event_type !== "string") {
    throw new SyntaxError("Not a PayPal webhook event.");
  }
  return event;
}

/**
 * Parse, verify, store once, then apply. Throws SyntaxError for a body that is not an event
 * (before any call to PayPal). An event that does not verify is not stored.
 */
export async function processWebhook(headers: Headers, rawBody: string, deps: WebhookDeps = defaultDeps): Promise<WebhookOutcome> {
  const event = parseEvent(rawBody);
  if (!(await deps.verify(headers, rawBody))) return { result: "unverified" };
  return handleWebhookEvent(event, deps, rawBody);
}

/** Apply a verified event at most once. */
export async function handleWebhookEvent(
  event: WebhookEvent,
  deps: Pick<WebhookDeps, "getOrder" | "getCapture"> = defaultDeps,
  raw: string = JSON.stringify(event),
): Promise<WebhookOutcome> {
  if (!insertWebhookEvent({ id: event.id, type: event.event_type, resourceId: resourceIdOf(event), verified: true, raw })) {
    return { result: "duplicate" };
  }
  try {
    return await apply(event, deps);
  } catch (err) {
    // Let PayPal's retry through instead of treating it as already handled.
    deleteWebhookEvent(event.id);
    throw err;
  }
}

// ---------- applying ----------

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function resourceIdOf(event: WebhookEvent): string | null {
  const r = event.resource ?? {};
  return str(r.id) ?? str(r.payout_item_id) ?? null;
}

function relatedOrderId(r: Json): string | null {
  const related = obj(obj(r.supplementary_data)?.related_ids);
  return str(related?.order_id);
}

/** The id at the end of the HATEOAS "up" link, e.g. .../v2/payments/captures/{id}. */
function upLinkId(r: Json, segment: string): string | null {
  const links = Array.isArray(r.links) ? r.links : [];
  for (const l of links) {
    const link = obj(l);
    const href = str(link?.href);
    if (link?.rel === "up" && href) {
      const m = new RegExp(`/${segment}/([^/?]+)`).exec(href);
      if (m?.[1]) return decodeURIComponent(m[1]);
    }
  }
  return null;
}

type Deps = Pick<WebhookDeps, "getOrder" | "getCapture">;

/**
 * Record a capture we had not stored yet, from PayPal's view of the order. If PayPal already
 * shows it fully refunded, the refund is recorded too.
 */
async function catchUpCapture(row: OrderRow, deps: Deps, captureId: string | null, refundId: string): Promise<boolean> {
  const view = await deps.getOrder(row.id);
  const status = view.captureStatus;
  if (status !== "COMPLETED" && status !== "PARTIALLY_REFUNDED" && status !== "REFUNDED") {
    throw new NotReadyYet(`PayPal reports the capture on order ${row.id} as ${status ?? "missing"}`);
  }
  const changed = recordCapture(row.id, { ...view, captureId: view.captureId ?? captureId }, ACTOR);
  if (status === "REFUNDED") recordRefund(row.id, refundId, ACTOR);
  return changed;
}

function refunded(row: OrderRow, refundId: string): WebhookOutcome {
  return recordRefund(row.id, refundId, ACTOR)
    ? { result: "applied", detail: `order ${row.code} refunded` }
    : { result: "ignored", detail: "already refunded" };
}

async function apply(event: WebhookEvent, deps: Deps): Promise<WebhookOutcome> {
  const r = event.resource ?? {};
  const type = event.event_type;

  if (type === "PAYMENT.CAPTURE.COMPLETED") {
    const orderId = relatedOrderId(r) ?? upLinkId(r, "orders");
    const row = orderId ? getOrderRow(orderId) : null;
    if (!orderId || !row) return { result: "ignored", detail: "not a Halftime order" };
    if (row.status === "COMPLETED" || row.status === "REFUNDED") return { result: "ignored", detail: `order already ${row.status}` };
    // The event only carries the capture. Line items come from GET order, which also shows a refund that already happened.
    const changed = await catchUpCapture(row, deps, str(r.id), "refunded-in-paypal");
    return changed ? { result: "applied", detail: `order ${row.code} paid` } : { result: "ignored", detail: "order already recorded" };
  }

  if (type === "PAYMENT.CAPTURE.REFUNDED") {
    const captureId = upLinkId(r, "captures");
    const orderId = relatedOrderId(r);
    let row = (captureId ? getOrderByCaptureId(captureId) : null) ?? (orderId ? getOrderRow(orderId) : null);
    if (row?.status === "REFUNDED") return { result: "ignored", detail: "already refunded" };
    // PayPal's capture tells whether refunds have used up the whole amount, and which order
    // it belongs to when we have not stored the capture id yet.
    const capture = captureId ? await deps.getCapture(captureId) : null;
    row ??= capture?.orderId ? getOrderRow(capture.orderId) : null;
    if (!row) return { result: "ignored", detail: "not a Halftime order" };
    const refundId = str(r.id) ?? `webhook-${event.id}`;
    // Refunded before we recorded the capture (events out of order, or the capture response was lost).
    if (row.status === "CREATED" || row.status === "DECLINED") await catchUpCapture(row, deps, captureId, refundId);
    const now = getOrderRow(row.id)!;
    if (now.status === "REFUNDED") return { result: "applied", detail: `order ${now.code} refunded` };

    if (capture && capture.status !== "REFUNDED" && capture.status !== "PARTIALLY_REFUNDED") {
      throw new NotReadyYet(`PayPal reports capture ${captureId} as ${capture.status ?? "missing"} after a refund`);
    }
    const total = str(obj(obj(r.seller_payable_breakdown)?.total_refunded_amount)?.value);
    const value = str(obj(r.amount)?.value);
    const refundedCents = total ? valueToCents(total) : value ? valueToCents(value) : null;
    // With no capture id to ask PayPal about, fall back to the amounts in the event.
    const full = capture ? capture.status === "REFUNDED" : refundedCents === null || refundedCents >= now.totalCents;
    if (full) return refunded(now, refundId);
    const night = getNight(now.nightId);
    audit(now.nightId, ACTOR, "order.partial_refund", { orderId: now.id, refundId: str(r.id), refundedCents });
    if (night) addNotice({ nightId: night.id, ...partialRefundNotice(night, now, refundedCents ?? 0) });
    return { result: "applied", detail: "partial refund noted" };
  }

  if (type === "PAYMENT.CAPTURE.DENIED" || type === "PAYMENT.CAPTURE.DECLINED") {
    const orderId = relatedOrderId(r) ?? upLinkId(r, "orders");
    const row = orderId ? getOrderRow(orderId) : null;
    if (!row) return { result: "ignored", detail: "not a Halftime order" };
    if (row.status !== "CREATED" && row.status !== "DECLINED") {
      audit(row.nightId, ACTOR, "order.capture_denied_after_paid", { orderId: row.id, status: row.status });
      return { result: "ignored", detail: `order is ${row.status}` };
    }
    markOrderDeclined(row.id, type);
    audit(row.nightId, ACTOR, "order.declined", { orderId: row.id, code: row.code, reason: type });
    publish(row.nightId, { type: "order.declined", orderId: row.id, code: row.code, reason: type });
    return { result: "applied", detail: `order ${row.code} declined` };
  }

  if (type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const itemId = str(r.payout_item_id);
    const batchId = str(r.payout_batch_id);
    const reimb = reimbursementForPayout({
      itemId,
      batchId,
      senderBatchId: str(r.sender_batch_id),
      senderItemId: str(obj(r.payout_item)?.sender_item_id),
    });
    if (!reimb) return { result: "ignored", detail: "not a current Halftime payout" };
    const payoutStatus = str(r.transaction_status) ?? type.slice("PAYMENT.PAYOUTS-ITEM.".length);
    recordPayoutStatus(reimb, { status: payoutStatus, batchId, itemId, error: str(obj(r.errors)?.message) }, ACTOR);
    return { result: "applied", detail: `payout ${payoutStatus}` };
  }

  return { result: "ignored", detail: `unhandled event type ${type}` };
}
