// PayPal webhooks. They back up the synchronous capture/refund paths and carry
// payout results. PayPal delivers at least once, so every event id is stored
// and applied at most once. Unverified events are kept for inspection but
// never change anything.

import { paypalConfig, paypalConfigured } from "../config";
import { publish } from "../events";
import { valueToCents } from "../money";
import { partialRefundNotice } from "../notice-text";
import {
  addNotice, audit, deleteWebhookEvent, findReimbursementByPayout, getNight, getOrder as getOrderRow, getOrderByCaptureId,
  insertWebhookEvent, markOrderDeclined, promoteWebhookEvent, updateReimbursement,
} from "../repo";
import { paypalFetch } from "./client";
import { getOrder as getPayPalOrder, recordCapture, recordRefund, type PayPalOrderView } from "./orders";
import { payoutFailed } from "./payouts";

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
}

export const defaultDeps: WebhookDeps = {
  verify: (headers, rawBody) => verifyWebhook(headers, rawBody),
  getOrder: (orderId) => getPayPalOrder(orderId),
};

export type WebhookOutcome =
  | { result: "applied"; detail: string }
  | { result: "ignored"; detail: string }
  | { result: "duplicate" }
  | { result: "unverified" };

// ---------- signature verification ----------

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
  if (Object.values(fields).some((v) => !v)) return false;
  // Splice in the body exactly as received. Re-serializing the parsed event can
  // change number formatting or escapes, and then PayPal reports FAILURE.
  const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
  try {
    const res = await paypalFetch<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", { rawBody: body });
    return res.verification_status === "SUCCESS";
  } catch (err) {
    console.warn("webhook verification call failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ---------- receiving ----------

/** Verify, parse, store once, then apply. Throws SyntaxError for a body that is not JSON. */
export async function processWebhook(headers: Headers, rawBody: string, deps: WebhookDeps = defaultDeps): Promise<WebhookOutcome> {
  const verified = await deps.verify(headers, rawBody);
  const event = JSON.parse(rawBody) as WebhookEvent;
  if (!event || typeof event.id !== "string" || typeof event.event_type !== "string") {
    throw new SyntaxError("Not a PayPal webhook event.");
  }
  return handleWebhookEvent(event, { verified, raw: rawBody }, deps);
}

export async function handleWebhookEvent(
  event: WebhookEvent,
  opts: { verified: boolean; raw?: string },
  deps: Pick<WebhookDeps, "getOrder"> = defaultDeps,
): Promise<WebhookOutcome> {
  const raw = opts.raw ?? JSON.stringify(event);
  const fresh = insertWebhookEvent({ id: event.id, type: event.event_type, resourceId: resourceIdOf(event), verified: opts.verified, raw });
  if (!fresh) {
    if (!opts.verified || !promoteWebhookEvent(event.id, raw)) return { result: "duplicate" };
  } else if (!opts.verified) {
    return { result: "unverified" };
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

async function apply(event: WebhookEvent, deps: Pick<WebhookDeps, "getOrder">): Promise<WebhookOutcome> {
  const r = event.resource ?? {};
  const type = event.event_type;

  if (type === "PAYMENT.CAPTURE.COMPLETED") {
    const orderId = relatedOrderId(r) ?? upLinkId(r, "orders");
    const row = orderId ? getOrderRow(orderId) : null;
    if (!orderId || !row) return { result: "ignored", detail: "not a Halftime order" };
    if (row.status === "COMPLETED" || row.status === "REFUNDED") return { result: "ignored", detail: `order already ${row.status}` };
    // The event only carries the capture. Line items come from GET order.
    const view = await deps.getOrder(orderId);
    const changed = recordCapture(orderId, { ...view, captureId: view.captureId ?? str(r.id) }, ACTOR);
    return changed ? { result: "applied", detail: `order ${row.code} paid` } : { result: "ignored", detail: "order already recorded" };
  }

  if (type === "PAYMENT.CAPTURE.REFUNDED") {
    const captureId = upLinkId(r, "captures");
    const orderId = relatedOrderId(r);
    const row = (captureId ? getOrderByCaptureId(captureId) : null) ?? (orderId ? getOrderRow(orderId) : null);
    if (!row) return { result: "ignored", detail: "not a Halftime order" };
    if (row.status !== "COMPLETED") return { result: "ignored", detail: `order is ${row.status}` };
    const refundValue = str(obj(r.amount)?.value);
    const refundCents = refundValue ? valueToCents(refundValue) : row.totalCents;
    if (refundCents < row.totalCents) {
      const night = getNight(row.nightId);
      audit(row.nightId, ACTOR, "order.partial_refund", { orderId: row.id, refundId: str(r.id), refundCents });
      if (night) addNotice({ nightId: night.id, ...partialRefundNotice(night, row, refundCents) });
      return { result: "applied", detail: "partial refund noted" };
    }
    const changed = recordRefund(row.id, str(r.id) ?? `webhook-${event.id}`, ACTOR);
    return changed ? { result: "applied", detail: `order ${row.code} refunded` } : { result: "ignored", detail: "already refunded" };
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
    const reimb = findReimbursementByPayout({ itemId, batchId });
    if (!reimb) return { result: "ignored", detail: "not a Halftime payout" };
    const payoutStatus = str(r.transaction_status) ?? type.slice("PAYMENT.PAYOUTS-ITEM.".length);
    const failed = payoutFailed(payoutStatus);
    const errors = obj(r.errors);
    updateReimbursement(reimb.id, {
      payoutStatus,
      itemId: reimb.itemId ?? itemId,
      ...(failed ? { status: "failed" as const, error: str(errors?.message) ?? `PayPal reported the payout as ${payoutStatus}.` } : {}),
    });
    audit(reimb.nightId, ACTOR, "reimbursement.payout_status", { id: reimb.id, payoutStatus, itemId });
    publish(reimb.nightId, { type: "reimbursement.updated", id: reimb.id });
    return { result: "applied", detail: `payout ${payoutStatus}` };
  }

  return { result: "ignored", detail: `unhandled event type ${type}` };
}
