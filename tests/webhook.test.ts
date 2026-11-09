import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/paypal/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/paypal/client")>()),
  paypalFetch: vi.fn(),
}));

import { db, resetDbForTests } from "../lib/db";
import { subscribe, type NightEvent } from "../lib/events";
import { PayPalError, paypalFetch } from "../lib/paypal/client";
import type { CaptureView, PayPalOrderView } from "../lib/paypal/orders";
import { PAYOUT_UNKNOWN, senderBatchIdFor } from "../lib/paypal/reimbursements";
import {
  NotReadyYet, VerificationUnavailable, handleWebhookEvent, processWebhook, verifyWebhook, type WebhookDeps, type WebhookEvent,
} from "../lib/paypal/webhooks";
import {
  audit, createNight, createReimbursement, getNight, getOrder, getReimbursement, insertOrder, listAudit, listNotices, reconcileNight,
  saveCount, setNightStatus, updateReimbursement,
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
  vi.unstubAllEnvs();
  vi.mocked(paypalFetch).mockReset();
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

function captureView(over: Partial<CaptureView> = {}): CaptureView {
  return { id: CAPTURE_ID, status: "REFUNDED", orderId: ORDER_ID, cents: 700, ...over };
}

/** Deps for a test; PayPal calls fail loudly unless the test provides them. */
function deps(over: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    verify: async () => true,
    getOrder: async () => {
      throw new Error("unexpected GET order");
    },
    getCapture: async () => {
      throw new Error("unexpected GET capture");
    },
    ...over,
  };
}

const paid = () => deps({ getOrder: async () => paypalView() });

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

    const out = await handleWebhookEvent(completedEvent(), deps({ getOrder: getOrderFromPayPal }));
    stop();

    expect(out).toEqual({ result: "applied", detail: "order K7A paid" });
    expect(getOrderFromPayPal).toHaveBeenCalledWith(ORDER_ID);
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "COMPLETED", captureId: CAPTURE_ID, funding: "venmo", totalCents: 700, items: LINES });
    expect(paypalUnits()).toBe(3);
    expect(events).toEqual([{ type: "order.paid", orderId: ORDER_ID, code: "K7A" }]);
    expect(listNotices(nightId)).toEqual([]);
  });

  it("ignores a repeated delivery of the same event id", async () => {
    const getOrderFromPayPal = vi.fn(async () => paypalView());
    await handleWebhookEvent(completedEvent(), deps({ getOrder: getOrderFromPayPal }));
    const again = await handleWebhookEvent(completedEvent(), deps({ getOrder: getOrderFromPayPal }));

    expect(again).toEqual({ result: "duplicate" });
    expect(getOrderFromPayPal).toHaveBeenCalledTimes(1);
  });

  it("does not store an event whose signature fails, so PayPal's re-send is applied", async () => {
    const getOrderFromPayPal = vi.fn(async () => paypalView());
    const out = await processWebhook(new Headers(), JSON.stringify(completedEvent()), deps({ verify: async () => false, getOrder: getOrderFromPayPal }));

    expect(out).toEqual({ result: "unverified" });
    expect(storedEvent("WH-COMPLETED-1")).toBeUndefined();
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
    expect(getOrderFromPayPal).not.toHaveBeenCalled();

    const retry = await processWebhook(new Headers(), JSON.stringify(completedEvent()), deps({ getOrder: getOrderFromPayPal }));
    expect(retry.result).toBe("applied");
    expect(storedEvent("WH-COMPLETED-1")).toEqual({ verified: 1 });
  });

  it("stores nothing when PayPal cannot be reached to verify, so the route can ask for a retry", async () => {
    const verify = vi.fn(async () => {
      throw new VerificationUnavailable("timeout");
    });
    await expect(processWebhook(new Headers(), JSON.stringify(completedEvent()), deps({ verify }))).rejects.toThrow(VerificationUnavailable);
    expect(storedEvent("WH-COMPLETED-1")).toBeUndefined();
  });

  it("lets PayPal's retry through when handling fails", async () => {
    const flaky = vi.fn<(id: string) => Promise<PayPalOrderView>>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(paypalView());
    await expect(handleWebhookEvent(completedEvent(), deps({ getOrder: flaky }))).rejects.toThrow("timeout");
    expect(storedEvent("WH-COMPLETED-1")).toBeUndefined();

    const retry = await handleWebhookEvent(completedEvent(), deps({ getOrder: flaky }));
    expect(retry.result).toBe("applied");
  });

  it("asks for a retry when GET order does not show the capture as complete yet", async () => {
    const pending = deps({ getOrder: async () => paypalView({ captureStatus: "PENDING" }) });
    await expect(handleWebhookEvent(completedEvent(), pending)).rejects.toThrow(NotReadyYet);
    expect(storedEvent("WH-COMPLETED-1")).toBeUndefined();
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
  });

  it("files a notice when a capture completes after selling ended", async () => {
    setNightStatus(nightId, "closed");
    const out = await handleWebhookEvent(completedEvent(), paid());

    expect(out.result).toBe("applied");
    expect(getOrder(ORDER_ID)?.status).toBe("COMPLETED");
    expect(listNotices(nightId).map((n) => n.title)).toEqual(["PayPal order K7A completed after selling ended"]);
  });

  it("records PayPal's amount and items when they differ from what was priced, with a notice", async () => {
    const changed = [{ sku: "hotdog", name: "Hot dog", quantity: 1, unitCents: 300 }];
    const out = await handleWebhookEvent(completedEvent(), deps({ getOrder: async () => paypalView({ items: changed, totalCents: 300, captureCents: 300 }) }));

    expect(out.result).toBe("applied");
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "COMPLETED", totalCents: 300, items: changed });
    const notice = listNotices(nightId)[0];
    expect(notice).toMatchObject({ level: "amber", title: "PayPal order K7A does not match what the menu priced" });
    expect(notice?.body).toContain("$7.00");
    expect(notice?.body).toContain("$3.00");
    expect(listAudit(nightId).some((a) => a.action === "order.amount_mismatch")).toBe(true);
  });

  it("removes refunded units from the PayPal column", async () => {
    await handleWebhookEvent(completedEvent(), paid());
    expect(paypalUnits()).toBe(3);

    const events: NightEvent[] = [];
    const stop = subscribe(nightId, (e) => events.push(e));
    const out = await handleWebhookEvent(refundedEvent(), deps({ getCapture: async () => captureView() }));
    stop();

    expect(out).toEqual({ result: "applied", detail: "order K7A refunded" });
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "REFUNDED", refundId: "1JU08902781691411" });
    expect(paypalUnits()).toBe(0);
    expect(events).toEqual([{ type: "order.refunded", orderId: ORDER_ID, code: "K7A" }]);
  });

  it("notes a partial refund without removing units", async () => {
    await handleWebhookEvent(completedEvent(), paid());
    const out = await handleWebhookEvent(refundedEvent("3.00"), deps({ getCapture: async () => captureView({ status: "PARTIALLY_REFUNDED" }) }));

    expect(out).toEqual({ result: "applied", detail: "partial refund noted" });
    expect(getOrder(ORDER_ID)?.status).toBe("COMPLETED");
    expect(paypalUnits()).toBe(3);
    expect(listNotices(nightId)[0]?.title).toBe("PayPal order K7A was partly refunded");
  });

  it("marks the order refunded once partial refunds add up to the whole capture", async () => {
    await handleWebhookEvent(completedEvent(), paid());
    await handleWebhookEvent(refundedEvent("3.00", "WH-REFUNDED-A"), deps({ getCapture: async () => captureView({ status: "PARTIALLY_REFUNDED" }) }));
    const second = refundedEvent("4.00", "WH-REFUNDED-B");
    second.resource!.id = "2KV19013892702522";
    const out = await handleWebhookEvent(second, deps({ getCapture: async () => captureView({ status: "REFUNDED" }) }));

    expect(out).toEqual({ result: "applied", detail: "order K7A refunded" });
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "REFUNDED", refundId: "2KV19013892702522" });
    expect(paypalUnits()).toBe(0);
  });

  it("resolves a refund that arrives before the capture was recorded by asking PayPal", async () => {
    const getCapture = vi.fn(async () => captureView());
    const getOrderFromPayPal = vi.fn(async () => paypalView({ captureStatus: "REFUNDED" }));
    const out = await handleWebhookEvent(refundedEvent(), deps({ getCapture, getOrder: getOrderFromPayPal }));

    expect(getCapture).toHaveBeenCalledWith(CAPTURE_ID);
    expect(out).toEqual({ result: "applied", detail: "order K7A refunded" });
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "REFUNDED", captureId: CAPTURE_ID, refundId: "1JU08902781691411" });
    expect(paypalUnits()).toBe(0);

    // The COMPLETED event that was delayed changes nothing.
    const late = await handleWebhookEvent(completedEvent(), deps({ getOrder: getOrderFromPayPal }));
    expect(late).toEqual({ result: "ignored", detail: "order already REFUNDED" });
    expect(getOrder(ORDER_ID)?.status).toBe("REFUNDED");
  });

  it("asks for a retry, without storing the event, when the capture behind a refund can't be looked up", async () => {
    const getCapture = vi.fn(async (): Promise<CaptureView> => {
      throw new PayPalError("Could not reach PayPal: timeout", 503, "NETWORK_ERROR", null, null);
    });
    await expect(handleWebhookEvent(refundedEvent(), deps({ getCapture }))).rejects.toThrow("timeout");
    expect(storedEvent("WH-REFUNDED-1")).toBeUndefined();
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
  });

  it("ignores a refund for a capture that belongs to another order", async () => {
    const out = await handleWebhookEvent(refundedEvent(), deps({ getCapture: async () => captureView({ orderId: "SOMEONE-ELSE" }) }));
    expect(out).toEqual({ result: "ignored", detail: "not a Halftime order" });
  });

  it("does not mark a refunded order paid when an old COMPLETED event arrives late", async () => {
    await handleWebhookEvent(completedEvent(), paid());
    await handleWebhookEvent(refundedEvent(), deps({ getCapture: async () => captureView() }));
    const late = await handleWebhookEvent(completedEvent("WH-COMPLETED-2"), paid());

    expect(late.result).toBe("ignored");
    expect(getOrder(ORDER_ID)?.status).toBe("REFUNDED");
  });

  it("marks a denied capture as declined", async () => {
    const out = await handleWebhookEvent({ ...completedEvent("WH-DENIED-1"), event_type: "PAYMENT.CAPTURE.DENIED" }, deps());
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
      deps(),
    );
    expect(out).toEqual({ result: "applied", detail: "payout UNCLAIMED" });
    expect(getReimbursement(rid)).toMatchObject({ status: "sent", payoutStatus: "UNCLAIMED", itemId: "ITEM-1" });

    await handleWebhookEvent(
      {
        id: "WH-PAYOUT-2",
        event_type: "PAYMENT.PAYOUTS-ITEM.RETURNED",
        resource: { payout_item_id: "ITEM-1", payout_batch_id: "BATCH-1", transaction_status: "RETURNED" },
      },
      deps(),
    );
    expect(getReimbursement(rid)).toMatchObject({ status: "failed", payoutStatus: "RETURNED" });
  });

  it("settles a payout PayPal never answered for, by its sender ids", async () => {
    const rid = createReimbursement({ nightId, requester: "Dana Reyes", payeeEmail: "dana@example.com", cents: 2350, memo: "Hot dog buns" });
    updateReimbursement(rid, { approver: "Pat Okafor", payoutStatus: PAYOUT_UNKNOWN, error: "PayPal did not answer." });

    const out = await handleWebhookEvent(
      {
        id: "WH-PAYOUT-3",
        event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        resource: {
          payout_item_id: "ITEM-9", payout_batch_id: "BATCH-9", transaction_status: "SUCCESS", sender_batch_id: rid,
          payout_item: { sender_item_id: rid, receiver: "dana@example.com" },
        },
      },
      deps(),
    );
    expect(out).toEqual({ result: "applied", detail: "payout SUCCESS" });
    expect(getReimbursement(rid)).toMatchObject({ status: "sent", batchId: "BATCH-9", itemId: "ITEM-9", payoutStatus: "SUCCESS", error: null });
  });

  it("ignores a late report about an earlier payout try", async () => {
    const rid = createReimbursement({ nightId, requester: "Dana Reyes", payeeEmail: "dana@example.com", cents: 2350, memo: "Hot dog buns" });
    // Try 1 failed and try 2 is waiting on PayPal.
    audit(nightId, "Pat Okafor", "reimbursement.payout_attempt", { id: rid, attempt: 2, senderBatchId: senderBatchIdFor(rid, 2) });
    updateReimbursement(rid, { approver: "Pat Okafor", payoutStatus: PAYOUT_UNKNOWN });

    const out = await handleWebhookEvent(
      {
        id: "WH-PAYOUT-OLD",
        event_type: "PAYMENT.PAYOUTS-ITEM.RETURNED",
        resource: {
          payout_item_id: "ITEM-OLD", payout_batch_id: "BATCH-OLD", transaction_status: "RETURNED", sender_batch_id: rid,
          payout_item: { sender_item_id: rid },
        },
      },
      deps(),
    );
    expect(out).toEqual({ result: "ignored", detail: "not a current Halftime payout" });
    expect(getReimbursement(rid)).toMatchObject({ status: "requested", payoutStatus: PAYOUT_UNKNOWN, batchId: null });
  });

  it("ignores events for orders that are not ours", async () => {
    const ev = completedEvent("WH-OTHER");
    (ev.resource!.supplementary_data as { related_ids: { order_id: string } }).related_ids.order_id = "SOMEONE-ELSE";
    ev.resource!.links = [];
    const out = await handleWebhookEvent(ev, paid());
    expect(out).toEqual({ result: "ignored", detail: "not a Halftime order" });
  });

  it("rejects a body that is not JSON before calling PayPal", async () => {
    const verify = vi.fn(async () => true);
    await expect(processWebhook(new Headers(), "not json", deps({ verify }))).rejects.toThrow(SyntaxError);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("webhook signature verification", () => {
  const headers = (over: Record<string, string> = {}) =>
    new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42",
      "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
      "paypal-transmission-sig": "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==",
      "paypal-transmission-time": "2026-11-09T06:40:00Z",
      ...over,
    });

  beforeEach(() => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-ID-1");
  });

  it("sends the raw body to PayPal and accepts SUCCESS", async () => {
    vi.mocked(paypalFetch).mockResolvedValue({ verification_status: "SUCCESS" });
    const raw = JSON.stringify(completedEvent());
    await expect(verifyWebhook(headers(), raw)).resolves.toBe(true);
    const sent = vi.mocked(paypalFetch).mock.calls[0]?.[1]?.rawBody ?? "";
    expect(sent.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(sent)).toMatchObject({ webhook_id: "WH-ID-1", cert_url: expect.stringContaining("paypal.com") });
  });

  it("returns false for FAILURE", async () => {
    vi.mocked(paypalFetch).mockResolvedValue({ verification_status: "FAILURE" });
    await expect(verifyWebhook(headers(), "{}")).resolves.toBe(false);
  });

  it("rejects a certificate URL outside PayPal without calling PayPal", async () => {
    await expect(verifyWebhook(headers({ "paypal-cert-url": "https://evil.example/cert.pem" }), "{}")).resolves.toBe(false);
    await expect(verifyWebhook(headers({ "paypal-cert-url": "https://paypal.com.evil.example/c" }), "{}")).resolves.toBe(false);
    expect(paypalFetch).not.toHaveBeenCalled();
  });

  it("throws VerificationUnavailable when PayPal can't be reached, and false when it refuses the request", async () => {
    vi.mocked(paypalFetch).mockRejectedValueOnce(new PayPalError("Could not reach PayPal: timeout", 503, "NETWORK_ERROR", null, null));
    await expect(verifyWebhook(headers(), "{}")).rejects.toThrow(VerificationUnavailable);

    vi.mocked(paypalFetch).mockRejectedValueOnce(new PayPalError("Invalid request", 400, "VALIDATION_ERROR", null, null));
    await expect(verifyWebhook(headers(), "{}")).resolves.toBe(false);
  });
});
