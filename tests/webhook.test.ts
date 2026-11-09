import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDbForTests } from "../lib/db";
import { subscribe, type NightEvent } from "../lib/events";
import type { PayPalOrderView } from "../lib/paypal/orders";
import { handleWebhookEvent, processWebhook, type WebhookEvent } from "../lib/paypal/webhooks";
import {
  createNight, createReimbursement, getNight, getOrder, getReimbursement, insertOrder, listNotices, reconcileNight, saveCount,
  setNightStatus, updateReimbursement,
} from "../lib/repo";
import { seedDemo } from "../lib/seed";

const ORDER_ID = "5O190127TN364715T";
const CAPTURE_ID = "3C679366HH908993F";
const LINES = [
  { sku: "hotdog", name: "Hot dog", quantity: 2, unitCents: 300 },
  { sku: "water", name: "Water", quantity: 1, unitCents: 100 },
];

let dir: string;
let nightId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-webhook-"));
  process.env.HALFTIME_DB = path.join(dir, "test.db");
  resetDbForTests();
  seedDemo(true);
  nightId = createNight({ title: "vs. Northridge", date: "2026-11-14", floatCents: 10_000 });
  saveCount({ nightId, kind: "open", counts: { water: 24, sports: 12, chips: 20, candy: 18, hotdog: 16 }, countedBy: "Marcus Hill", checkedBy: "Priya Shah" });
  setNightStatus(nightId, "selling");
  insertOrder({ id: ORDER_ID, nightId, booth: "window", code: "K7A", items: LINES, totalCents: 700 });
});

afterEach(() => {
  resetDbForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function paypalView(over: Partial<PayPalOrderView> = {}): PayPalOrderView {
  return {
    id: ORDER_ID, status: "COMPLETED", referenceId: nightId, customId: `${nightId}:window`, invoiceId: `${nightId}-K7A`,
    items: LINES, totalCents: 700, captureId: CAPTURE_ID, captureStatus: "COMPLETED", captureCents: 700,
    payer: "buyer@example.com", funding: "venmo", ...over,
  };
}

function completedEvent(id = "WH-COMPLETED-1"): WebhookEvent {
  return {
    id,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource_type: "capture",
    resource: {
      id: CAPTURE_ID,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "7.00" },
      supplementary_data: { related_ids: { order_id: ORDER_ID } },
      links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/checkout/orders/${ORDER_ID}`, method: "GET" }],
    },
  };
}

function refundedEvent(value = "7.00", id = "WH-REFUNDED-1"): WebhookEvent {
  return {
    id,
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource_type: "refund",
    resource: {
      id: "1JU08902781691411",
      status: "COMPLETED",
      amount: { currency_code: "USD", value },
      links: [
        { rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/1JU08902781691411", method: "GET" },
        { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${CAPTURE_ID}`, method: "GET" },
      ],
    },
  };
}

function storedEvent(id: string): { verified: number } | undefined {
  return db().prepare("SELECT verified FROM webhook_event WHERE id = ?").get(id) as { verified: number } | undefined;
}

function paypalUnits(): number {
  return reconcileNight(getNight(nightId)!).paypalUnits;
}

describe("PayPal webhooks", () => {
  it("backfills a capture the browser never reported, using GET order", async () => {
    const getOrderFromPayPal = vi.fn(async () => paypalView());
    const events: NightEvent[] = [];
    const stop = subscribe(nightId, (e) => events.push(e));

    const out = await handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: getOrderFromPayPal });
    stop();

    expect(out).toEqual({ result: "applied", detail: "order K7A paid" });
    expect(getOrderFromPayPal).toHaveBeenCalledWith(ORDER_ID);
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "COMPLETED", captureId: CAPTURE_ID, funding: "venmo", totalCents: 700, items: LINES });
    expect(paypalUnits()).toBe(3);
    expect(events).toEqual([{ type: "order.paid", orderId: ORDER_ID, code: "K7A" }]);
  });

  it("ignores a repeated delivery of the same event id", async () => {
    const getOrderFromPayPal = vi.fn(async () => paypalView());
    await handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: getOrderFromPayPal });
    const again = await handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: getOrderFromPayPal });

    expect(again).toEqual({ result: "duplicate" });
    expect(getOrderFromPayPal).toHaveBeenCalledTimes(1);
  });

  it("stores an unverified event without acting on it", async () => {
    const getOrderFromPayPal = vi.fn(async () => paypalView());
    const out = await processWebhook(new Headers(), JSON.stringify(completedEvent()), { verify: async () => false, getOrder: getOrderFromPayPal });

    expect(out).toEqual({ result: "unverified" });
    expect(storedEvent("WH-COMPLETED-1")).toEqual({ verified: 0 });
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
    expect(getOrderFromPayPal).not.toHaveBeenCalled();
  });

  it("applies an event once a later delivery of it verifies", async () => {
    const deps = { getOrder: vi.fn(async () => paypalView()) };
    await handleWebhookEvent(completedEvent(), { verified: false }, deps);
    const out = await handleWebhookEvent(completedEvent(), { verified: true }, deps);

    expect(out.result).toBe("applied");
    expect(storedEvent("WH-COMPLETED-1")).toEqual({ verified: 1 });
    expect(getOrder(ORDER_ID)?.status).toBe("COMPLETED");
  });

  it("lets PayPal's retry through when handling fails", async () => {
    const flaky = vi.fn<(id: string) => Promise<PayPalOrderView>>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(paypalView());
    await expect(handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: flaky })).rejects.toThrow("timeout");
    expect(storedEvent("WH-COMPLETED-1")).toBeUndefined();

    const retry = await handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: flaky });
    expect(retry.result).toBe("applied");
  });

  it("removes refunded units from the PayPal column", async () => {
    await handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: async () => paypalView() });
    expect(paypalUnits()).toBe(3);

    const events: NightEvent[] = [];
    const stop = subscribe(nightId, (e) => events.push(e));
    const out = await handleWebhookEvent(refundedEvent(), { verified: true });
    stop();

    expect(out).toEqual({ result: "applied", detail: "order K7A refunded" });
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "REFUNDED", refundId: "1JU08902781691411" });
    expect(paypalUnits()).toBe(0);
    expect(events).toEqual([{ type: "order.refunded", orderId: ORDER_ID, code: "K7A" }]);
  });

  it("notes a partial refund without removing units", async () => {
    await handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: async () => paypalView() });
    const out = await handleWebhookEvent(refundedEvent("3.00"), { verified: true });

    expect(out).toEqual({ result: "applied", detail: "partial refund noted" });
    expect(getOrder(ORDER_ID)?.status).toBe("COMPLETED");
    expect(paypalUnits()).toBe(3);
    expect(listNotices(nightId)[0]?.title).toBe("PayPal order K7A was partly refunded");
  });

  it("does not mark a refunded order paid when an old COMPLETED event arrives late", async () => {
    await handleWebhookEvent(completedEvent(), { verified: true }, { getOrder: async () => paypalView() });
    await handleWebhookEvent(refundedEvent(), { verified: true });
    const late = await handleWebhookEvent(completedEvent("WH-COMPLETED-2"), { verified: true }, { getOrder: async () => paypalView() });

    expect(late.result).toBe("ignored");
    expect(getOrder(ORDER_ID)?.status).toBe("REFUNDED");
  });

  it("marks a denied capture as declined", async () => {
    const out = await handleWebhookEvent(
      { ...completedEvent("WH-DENIED-1"), event_type: "PAYMENT.CAPTURE.DENIED" },
      { verified: true },
    );
    expect(out.result).toBe("applied");
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "DECLINED", declineReason: "PAYMENT.CAPTURE.DENIED" });
  });

  it("records payout item status on the matching reimbursement", async () => {
    const rid = createReimbursement({ nightId, requester: "Dana Reyes", payeeEmail: "dana@example.com", cents: 2350, memo: "Hot dog buns" });
    updateReimbursement(rid, { status: "sent", approver: "Pat Okafor", batchId: "BATCH-1", itemId: null, payoutStatus: "PENDING" });

    const out = await handleWebhookEvent(
      {
        id: "WH-PAYOUT-1",
        event_type: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
        resource: { payout_item_id: "ITEM-1", payout_batch_id: "BATCH-1", transaction_status: "UNCLAIMED" },
      },
      { verified: true },
    );
    expect(out).toEqual({ result: "applied", detail: "payout UNCLAIMED" });
    expect(getReimbursement(rid)).toMatchObject({ status: "sent", payoutStatus: "UNCLAIMED", itemId: "ITEM-1" });

    await handleWebhookEvent(
      {
        id: "WH-PAYOUT-2",
        event_type: "PAYMENT.PAYOUTS-ITEM.RETURNED",
        resource: { payout_item_id: "ITEM-1", payout_batch_id: "BATCH-1", transaction_status: "RETURNED" },
      },
      { verified: true },
    );
    expect(getReimbursement(rid)).toMatchObject({ status: "failed", payoutStatus: "RETURNED" });
  });

  it("ignores events for orders that are not ours", async () => {
    const ev = completedEvent("WH-OTHER");
    (ev.resource!.supplementary_data as { related_ids: { order_id: string } }).related_ids.order_id = "SOMEONE-ELSE";
    ev.resource!.links = [];
    const out = await handleWebhookEvent(ev, { verified: true }, { getOrder: async () => paypalView() });
    expect(out).toEqual({ result: "ignored", detail: "not a Halftime order" });
  });

  it("rejects a body that is not JSON", async () => {
    await expect(processWebhook(new Headers(), "not json", { verify: async () => false, getOrder: async () => paypalView() })).rejects.toThrow(SyntaxError);
  });
});
