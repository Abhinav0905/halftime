// Orders v2 and refunds through the PayPal Server SDK. Every function returns a
// small plain object so route handlers never touch SDK response types.

import type { CapturedPayment, Order, OrdersCapture, Refund } from "@paypal/paypal-server-sdk";
import { publish } from "../events";
import { formatCents, valueToCents } from "../money";
import { gameName, lateCaptureNotice, lateRefundNotice, type NoticeDraft } from "../notice-text";
import {
  addNotice, audit, getNight, getOrder as getOrderRow, listItems, markOrderCompleted, markOrderRefunded, reconcileNight,
  type Item, type Night, type OrderItem, type OrderRow,
} from "../repo";
import { paypal, toPayPalError } from "./client";
import { linesFromPayPalItems, type BuiltOrder } from "./payload";

/** Sandbox negative testing: makes the capture fail as a declined card would. */
export const MOCK_DECLINE = JSON.stringify({ mock_application_codes: "INSTRUMENT_DECLINED" });

export type Funding = "paypal" | "venmo" | "card" | "apple_pay" | "google_pay" | null;

export interface PayPalOrderView {
  id: string;
  status: string;
  referenceId: string | null;
  customId: string | null;
  invoiceId: string | null;
  /** Item lines exactly as PayPal recorded them, named from our catalog. */
  items: OrderItem[];
  totalCents: number | null;
  captureId: string | null;
  captureStatus: string | null;
  captureCents: number | null;
  payer: string | null;
  funding: Funding;
}

// After a decline and a retry an order can carry more than one capture. The one
// that took money matters, whether or not it has been refunded since.
const CAPTURE_PREFERENCE = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "PENDING"];

function pickCapture(captures: OrdersCapture[] | undefined): OrdersCapture | null {
  if (!captures?.length) return null;
  for (const status of CAPTURE_PREFERENCE) {
    const found = captures.find((c) => c.status === status);
    if (found) return found;
  }
  return captures[captures.length - 1] ?? null;
}

function fundingOf(order: Order): Funding {
  const src = order.paymentSource;
  if (!src) return null;
  if (src.venmo) return "venmo";
  if (src.paypal) return "paypal";
  if (src.card) return "card";
  if (src.applePay) return "apple_pay";
  if (src.googlePay) return "google_pay";
  return null;
}

function cents(value: string | undefined): number | null {
  return value === undefined ? null : valueToCents(value);
}

export function viewOrder(order: Order, catalog: Item[]): PayPalOrderView {
  const unit = order.purchaseUnits?.[0];
  const capture = pickCapture(unit?.payments?.captures);
  return {
    id: order.id ?? "",
    status: order.status ?? "UNKNOWN",
    referenceId: unit?.referenceId ?? null,
    customId: unit?.customId ?? null,
    invoiceId: unit?.invoiceId ?? null,
    items: linesFromPayPalItems(unit?.items, catalog),
    totalCents: cents(unit?.amount?.value),
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ?? null,
    captureCents: cents(capture?.amount?.value),
    payer: order.paymentSource?.paypal?.emailAddress ?? order.paymentSource?.venmo?.emailAddress ?? order.payer?.emailAddress ?? null,
    funding: fundingOf(order),
  };
}

export async function createOrder(built: BuiltOrder, requestId: string): Promise<{ id: string; status: string }> {
  let order: Order;
  try {
    ({ result: order } = await paypal().orders.createOrder({
      body: built.body,
      paypalRequestId: requestId,
      prefer: "return=minimal",
    }));
  } catch (err) {
    throw toPayPalError(err);
  }
  if (!order.id) throw new Error("PayPal did not return an order id.");
  return { id: order.id, status: order.status ?? "CREATED" };
}

export async function captureOrder(id: string, opts: { mockDecline?: boolean } = {}, catalog: Item[] = listItems()): Promise<PayPalOrderView> {
  try {
    const { result } = await paypal().orders.captureOrder({
      id,
      // One key per order, so a retried request cannot capture twice. PayPal does not replay
      // failed responses for a key (see docs/sandbox-findings.md), so paying again after a decline works.
      paypalRequestId: `capture-${id}`,
      paypalMockResponse: opts.mockDecline ? MOCK_DECLINE : undefined,
      prefer: "return=representation",
    });
    return viewOrder(result, catalog);
  } catch (err) {
    throw toPayPalError(err);
  }
}

export async function getOrder(id: string, catalog: Item[] = listItems()): Promise<PayPalOrderView> {
  try {
    const { result } = await paypal().orders.getOrder({ id });
    return viewOrder(result, catalog);
  } catch (err) {
    throw toPayPalError(err);
  }
}

export interface CaptureView {
  id: string;
  /** COMPLETED, PENDING, PARTIALLY_REFUNDED, REFUNDED, DECLINED or FAILED. */
  status: string | null;
  orderId: string | null;
  cents: number | null;
}

export function viewCapture(capture: CapturedPayment): CaptureView {
  return {
    id: capture.id ?? "",
    status: capture.status ?? null,
    orderId: capture.supplementaryData?.relatedIds?.orderId ?? null,
    cents: cents(capture.amount?.value),
  };
}

/** One capture as PayPal sees it now, including whether refunds have used up its whole amount. */
export async function getCapture(captureId: string): Promise<CaptureView> {
  try {
    const { result } = await paypal().payments.getCapturedPayment({ captureId });
    return viewCapture(result);
  } catch (err) {
    throw toPayPalError(err);
  }
}

/** Full refund of one capture. Keyed on our order id so a double-clicked refund only refunds once. */
export async function refundCapture(captureId: string, orderId: string): Promise<{ id: string; status: string; cents: number | null }> {
  let refund: Refund;
  try {
    ({ result: refund } = await paypal().payments.refundCapturedPayment({
      captureId,
      paypalRequestId: `refund-${orderId}`,
      prefer: "return=representation",
    }));
  } catch (err) {
    throw toPayPalError(err);
  }
  if (!refund.id) throw new Error("PayPal did not return a refund id.");
  return { id: refund.id, status: refund.status ?? "PENDING", cents: cents(refund.amount?.value) };
}

// ---------- recording PayPal results in our database ----------
// Shared by the capture/refund routes and the webhook handler. Each one re-reads
// the row and writes it without awaiting in between, so whichever path arrives
// second sees the first one's write and does not announce the change twice.

function sameLines(a: OrderItem[], b: OrderItem[]): boolean {
  const key = (lines: OrderItem[]) =>
    JSON.stringify([...lines].sort((x, y) => x.sku.localeCompare(y.sku)).map((l) => [l.sku, l.quantity, l.unitCents]));
  return key(a) === key(b);
}

function describeLines(lines: OrderItem[]): string {
  return lines.length ? lines.map((l) => `${l.quantity} × ${l.name}`).join(", ") : "no items listed";
}

function mismatchNotice(night: Night, priced: OrderRow, paid: { items: OrderItem[]; totalCents: number }): NoticeDraft {
  return {
    level: "amber",
    title: `PayPal order ${priced.code} does not match what the menu priced`,
    body:
      `The menu priced order ${priced.code} from ${gameName(night)} at ${formatCents(priced.totalCents)} (${describeLines(priced.items)}). ` +
      `PayPal recorded ${formatCents(paid.totalCents)} (${describeLines(paid.items)}). ` +
      `The night counts PayPal's numbers, because that is the money that came in. ` +
      `Please compare the order in the PayPal dashboard with what was handed over at the window.`,
  };
}

/**
 * Store a capture PayPal completed, using PayPal's view of the order. Returns true if the order was newly marked paid.
 * PayPal's items and amount are recorded even when they differ from what we priced, since they are the money that
 * actually moved; a difference, or a capture that lands after selling ended, files a notice for the officers.
 */
export function recordCapture(orderId: string, view: PayPalOrderView, actor: string): boolean {
  const row = getOrderRow(orderId);
  if (!row || row.status === "COMPLETED" || row.status === "REFUNDED") return false;
  const items = view.items.length ? view.items : row.items;
  const totalCents = view.captureCents ?? view.totalCents ?? row.totalCents;
  if (!view.items.length) audit(row.nightId, actor, "order.items_missing", { orderId });
  markOrderCompleted(orderId, {
    captureId: view.captureId ?? row.captureId ?? "",
    items,
    totalCents,
    payer: view.payer,
    funding: view.funding,
  });
  audit(row.nightId, actor, "order.paid", { orderId, code: row.code, captureId: view.captureId, totalCents, funding: view.funding });
  publish(row.nightId, { type: "order.paid", orderId, code: row.code });

  const night = getNight(row.nightId);
  if (totalCents !== row.totalCents || !sameLines(items, row.items)) {
    audit(row.nightId, actor, "order.amount_mismatch", {
      orderId, createdCents: row.totalCents, paypalOrderCents: view.totalCents, capturedCents: view.captureCents,
      createdItems: row.items, paypalItems: items,
    });
    if (night) addNotice({ nightId: night.id, ...mismatchNotice(night, row, { items, totalCents }) });
  }
  if (night && night.status !== "selling") {
    addNotice({ nightId: night.id, ...lateCaptureNotice(night, { ...row, items, totalCents }) });
  }
  return true;
}

/** Mark a COMPLETED order refunded. Returns true if it changed. */
export function recordRefund(orderId: string, refundId: string, actor: string): boolean {
  const row = getOrderRow(orderId);
  if (!row || row.status !== "COMPLETED") return false;
  const night = getNight(row.nightId);
  // After close-out the notice says how the night's expected cash moved, so keep the numbers from before.
  const before = night && (night.status === "closed" || night.status === "deposited") ? reconcileNight(night) : null;
  markOrderRefunded(orderId, refundId);
  audit(row.nightId, actor, "order.refunded", { orderId, code: row.code, refundId, totalCents: row.totalCents });
  publish(row.nightId, { type: "order.refunded", orderId, code: row.code });
  if (night && before) {
    addNotice({ nightId: night.id, ...lateRefundNotice(night, row, { before, after: reconcileNight(night) }) });
  }
  return true;
}
