// Payment and payout routes called directly with Request objects against a throwaway database.
// The PayPal layer is mocked: nothing here reaches PayPal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/paypal/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal/client")>()),
  paypalFetch: vi.fn(() => {
    throw new Error("PayPal must not be called from these tests.");
  }),
}));

vi.mock("@/lib/paypal/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal/orders")>()),
  createOrder: vi.fn(),
  captureOrder: vi.fn(),
  getOrder: vi.fn(),
  getCapture: vi.fn(),
  refundCapture: vi.fn(),
}));

vi.mock("@/lib/paypal/payouts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal/payouts")>()),
  sendPayout: vi.fn(),
  getPayoutBatch: vi.fn(),
  getPayoutItem: vi.fn(),
}));

import { GET as getOrderStatus } from "@/app/api/orders/[id]/route";
import { POST as postCapture } from "@/app/api/orders/[id]/capture/route";
import { POST as postOrder } from "@/app/api/orders/route";
import { POST as postApprove } from "@/app/api/reimbursements/[rid]/approve/route";
import { POST as postRefresh } from "@/app/api/reimbursements/[rid]/refresh/route";
import { POST as postRetry } from "@/app/api/reimbursements/[rid]/retry/route";
import { resetDbForTests } from "@/lib/db";
import { PayPalError, paypalFetch } from "@/lib/paypal/client";
import type { Order } from "@paypal/paypal-server-sdk";
import { captureOrder, createOrder, getOrder as getPayPalOrder, viewOrder, type PayPalOrderView } from "@/lib/paypal/orders";
import { getPayoutItem, rejectsEarlierSend, sendPayout, type PayoutOutcome } from "@/lib/paypal/payouts";
import { PAYOUT_UNKNOWN } from "@/lib/paypal/reimbursements";
import {
  audit, createNight, createReimbursement, getOrder, getReimbursement, insertOrder, listAudit, listItems, listNotices, saveCount, setNightStatus,
  updateReimbursement,
} from "@/lib/repo";
import { seedDemo } from "@/lib/seed";

const ORDER_ID = "5O190127TN364715T";
const CAPTURE_ID = "3C679366HH908993F";
const LINES = [
  { sku: "hotdog", name: "Hot dog", quantity: 2, unitCents: 300 },
  { sku: "water", name: "Water", quantity: 1, unitCents: 100 },
];
const OPEN = { water: 24, sports: 12, chips: 20, candy: 18, hotdog: 16 };

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;

async function call<P>(handler: Handler<P>, params: P, body?: unknown, method = "POST") {
  const req = new Request("http://halftime.test/api", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const capture = (id = ORDER_ID, body: unknown = {}) => call(postCapture, { id }, body);

function view(over: Partial<PayPalOrderView> = {}): PayPalOrderView {
  return {
    id: ORDER_ID, status: "COMPLETED", referenceId: nightId, customId: `${nightId}:window`, invoiceId: `${nightId}-K7A`,
    items: LINES, totalCents: 700, captureId: CAPTURE_ID, captureStatus: "COMPLETED", captureCents: 700,
    payer: "buyer@example.com", funding: "venmo", ...over,
  };
}

const networkError = () => new PayPalError("Could not reach PayPal: timeout", 503, "NETWORK_ERROR", null, null);

let dir: string;
let nightId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-payments-"));
  vi.stubEnv("HALFTIME_DB", path.join(dir, "test.db"));
  resetDbForTests();
  seedDemo(true);
  nightId = createNight({ title: "vs. Northridge", date: "2026-11-14", floatCents: 10_000 });
  saveCount({ nightId, kind: "open", counts: OPEN, countedBy: "Marcus Hill", checkedBy: "Priya Shah" });
  setNightStatus(nightId, "selling");
  insertOrder({ id: ORDER_ID, nightId, booth: "window", code: "K7A", items: LINES, totalCents: 700 });
});

afterEach(() => {
  resetDbForTests();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/orders", () => {
  beforeEach(() => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  });

  it("creates the PayPal order and stores it", async () => {
    vi.mocked(createOrder).mockResolvedValue({ id: "NEW-ORDER-1", status: "CREATED" });
    const res = await call(postOrder, {}, { nightId, cart: { water: 2 }, requestId: "req-12345678" });
    expect(res.status).toBe(201);
    expect(getOrder("NEW-ORDER-1")).toMatchObject({ status: "CREATED", totalCents: 200 });
  });

  it("does not store an order when the closing count starts while PayPal is creating it", async () => {
    vi.mocked(createOrder).mockImplementation(async () => {
      setNightStatus(nightId, "closing");
      return { id: "NEW-ORDER-2", status: "CREATED" };
    });
    const res = await call(postOrder, {}, { nightId, cart: { water: 2 }, requestId: "req-87654321" });
    expect(res.status).toBe(409);
    expect(getOrder("NEW-ORDER-2")).toBeNull();
  });
});

describe("GET /api/orders/[id]", () => {
  it("returns only what the buyer's phone needs", async () => {
    const res = await call(getOrderStatus, { id: ORDER_ID }, undefined, "GET");
    expect(res).toEqual({ status: 200, json: { status: "CREATED", code: "K7A", items: LINES, totalCents: 700 } });
  });

  it("404s for an unknown order", async () => {
    expect((await call(getOrderStatus, { id: "NOPE" }, undefined, "GET")).status).toBe(404);
  });
});

describe("POST /api/orders/[id]/capture", () => {
  it("stores PayPal's GET order items and total", async () => {
    const fromPayPal = [{ sku: "hotdog", name: "Hot dog", quantity: 2, unitCents: 300 }, { sku: "water", name: "Water", quantity: 1, unitCents: 100 }];
    vi.mocked(captureOrder).mockResolvedValue(view({ items: [] }));
    vi.mocked(getPayPalOrder).mockResolvedValue(view({ items: fromPayPal }));

    const res = await capture();
    expect(res).toEqual({ status: 200, json: { status: "COMPLETED", code: "K7A", items: fromPayPal, totalCents: 700 } });
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "COMPLETED", captureId: CAPTURE_ID, payer: "buyer@example.com" });
  });

  const notCaptured = () => view({ status: "APPROVED", captureId: null, captureStatus: null, captureCents: null });

  it.each(["closing", "closed", "deposited"] as const)("asks PayPal, then refuses without capturing once the night is %s", async (status) => {
    setNightStatus(nightId, status);
    vi.mocked(getPayPalOrder).mockResolvedValue(notCaptured());
    const res = await capture();

    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ reason: "STAND_CLOSED" });
    expect(String(res.json.error)).toContain("not charged");
    expect(getPayPalOrder).toHaveBeenCalledTimes(1);
    expect(captureOrder).not.toHaveBeenCalled();
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
  });

  it("records a capture that went through before the stand closed, with a notice, after the first answer was lost", async () => {
    // The first try timed out and PayPal could not be asked, so the phone got a 502. Then the closing count started.
    vi.mocked(captureOrder).mockRejectedValueOnce(networkError());
    vi.mocked(getPayPalOrder).mockRejectedValueOnce(networkError());
    expect((await capture()).status).toBe(502);
    setNightStatus(nightId, "closing");

    vi.mocked(getPayPalOrder).mockResolvedValueOnce(view());
    const res = await capture();
    expect(res).toEqual({ status: 200, json: { status: "COMPLETED", code: "K7A", items: LINES, totalCents: 700 } });
    expect(getOrder(ORDER_ID)).toMatchObject({ status: "COMPLETED", captureId: CAPTURE_ID });
    expect(captureOrder).toHaveBeenCalledTimes(1);
    expect(listNotices(nightId).map((n) => n.title)).toEqual(["PayPal order K7A completed after selling ended"]);
  });

  it("answers 202 after the stand closed when PayPal is still reviewing the payment", async () => {
    setNightStatus(nightId, "closing");
    vi.mocked(getPayPalOrder).mockResolvedValue(view({ captureStatus: "PENDING" }));
    expect(await capture()).toEqual({ status: 202, json: { status: "PENDING", code: "K7A" } });
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
    expect(captureOrder).not.toHaveBeenCalled();
  });

  it("says not charged after the stand closed when PayPal shows only a declined capture", async () => {
    setNightStatus(nightId, "closed");
    vi.mocked(getPayPalOrder).mockResolvedValue(view({ status: "APPROVED", captureStatus: "DECLINED" }));
    const res = await capture();
    expect(res.json).toMatchObject({ reason: "STAND_CLOSED" });
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
  });

  it("does not say not charged after the stand closed when PayPal can't be asked", async () => {
    setNightStatus(nightId, "closing");
    vi.mocked(getPayPalOrder).mockRejectedValue(networkError());
    const res = await capture();
    expect(res.status).toBe(502);
    expect(String(res.json.error)).toContain("don't pay again");
    expect(captureOrder).not.toHaveBeenCalled();
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
  });

  it("refuses an offline demo order after selling ended too, without asking PayPal", async () => {
    insertOrder({ id: "SIM-late", nightId, booth: "window", code: "M4P", items: LINES, totalCents: 700, simulated: true });
    setNightStatus(nightId, "closed");
    expect((await capture("SIM-late")).status).toBe(409);
    expect(getPayPalOrder).not.toHaveBeenCalled();
    expect(getOrder("SIM-late")?.status).toBe("CREATED");
    expect(listNotices(nightId)).toEqual([]);
  });

  it("answers 402 for a declined card so the buyer can pick another way to pay", async () => {
    vi.mocked(captureOrder).mockRejectedValue(new PayPalError("Declined", 422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "dbg"));
    const res = await capture();
    expect(res).toEqual({ status: 402, json: { status: "DECLINED", issue: "INSTRUMENT_DECLINED", code: "K7A" } });
    expect(getOrder(ORDER_ID)?.status).toBe("DECLINED");
  });

  it("asks PayPal when the capture call gets no answer, and records a capture that went through", async () => {
    vi.mocked(captureOrder).mockRejectedValue(networkError());
    vi.mocked(getPayPalOrder).mockResolvedValue(view());

    const res = await capture();
    expect(res.status).toBe(200);
    expect(getOrder(ORDER_ID)?.status).toBe("COMPLETED");
    expect(getPayPalOrder).toHaveBeenCalledTimes(1);
  });

  it("answers 502 without recording anything when PayPal shows no capture after a lost answer", async () => {
    vi.mocked(captureOrder).mockRejectedValue(networkError());
    vi.mocked(getPayPalOrder).mockResolvedValue(view({ status: "APPROVED", captureId: null, captureStatus: null, captureCents: null }));

    const res = await capture();
    expect(res.status).toBe(502);
    expect(String(res.json.error)).toContain("don't pay again");
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
  });

  it("answers 502, not 500, when PayPal can't be asked after ORDER_ALREADY_CAPTURED", async () => {
    vi.mocked(captureOrder).mockRejectedValue(new PayPalError("Already captured", 422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED", null));
    vi.mocked(getPayPalOrder).mockRejectedValue(networkError());
    expect((await capture()).status).toBe(502);
  });

  it("records an already captured order from GET order", async () => {
    vi.mocked(captureOrder).mockRejectedValue(new PayPalError("Already captured", 422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED", null));
    vi.mocked(getPayPalOrder).mockResolvedValue(view());
    expect((await capture()).status).toBe(200);
    expect(getOrder(ORDER_ID)?.status).toBe("COMPLETED");
  });

  it("says plainly that nothing was charged when PayPal refuses the capture", async () => {
    vi.mocked(captureOrder).mockRejectedValue(new PayPalError("Payer cannot pay", 422, "UNPROCESSABLE_ENTITY", "PAYER_CANNOT_PAY", null));
    const res = await capture();
    expect(res.status).toBe(422);
    expect(String(res.json.error)).toContain("nothing was charged");
  });

  it("answers 202 PENDING and leaves the order open while PayPal reviews the payment", async () => {
    vi.mocked(captureOrder).mockResolvedValue(view({ captureStatus: "PENDING" }));
    vi.mocked(getPayPalOrder).mockResolvedValue(view({ captureStatus: "PENDING" }));
    const res = await capture();
    expect(res).toEqual({ status: 202, json: { status: "PENDING", code: "K7A" } });
    expect(getOrder(ORDER_ID)?.status).toBe("CREATED");
  });

  it("answers 409, not a broken 202, for a capture PayPal already shows as refunded", async () => {
    vi.mocked(captureOrder).mockResolvedValue(view({ captureStatus: "REFUNDED" }));
    vi.mocked(getPayPalOrder).mockResolvedValue(view({ captureStatus: "REFUNDED" }));
    const res = await capture();
    expect(res.status).toBe(409);
    expect(String(res.json.error)).toContain("refunded");
  });

  it("keeps PayPal's numbers when they differ from what was priced, and tells the officers", async () => {
    const one = [{ sku: "hotdog", name: "Hot dog", quantity: 1, unitCents: 300 }];
    vi.mocked(captureOrder).mockResolvedValue(view({ items: one, totalCents: 300, captureCents: 300 }));
    vi.mocked(getPayPalOrder).mockResolvedValue(view({ items: one, totalCents: 300, captureCents: 300 }));

    const res = await capture();
    expect(res.json).toMatchObject({ status: "COMPLETED", totalCents: 300, items: one });
    expect(listNotices(nightId).map((n) => n.level)).toEqual(["amber"]);
    expect(listAudit(nightId).some((a) => a.action === "order.amount_mismatch")).toBe(true);
  });
});

// ---------- reimbursements ----------

const sent = (over: Partial<Extract<PayoutOutcome, { kind: "sent" }>> = {}): PayoutOutcome =>
  ({ kind: "sent", batchId: "BATCH-1", itemId: "ITEM-1", status: "PENDING", error: null, ...over });

function newRequest(): string {
  return createReimbursement({ nightId, requester: "Jordan Lee", payeeEmail: "jordan@example.com", cents: 2350, memo: "Hot dog buns" });
}

const approve = (rid: string, approver = "Pat Okafor") => call(postApprove, { rid }, { approver });
const refresh = (rid: string) => call(postRefresh, { rid });
const retry = (rid: string, body: Record<string, unknown>) => call(postRetry, { rid }, body);

describe("reimbursement payouts", () => {
  beforeEach(() => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  });

  it("sends with the reimbursement id as sender_batch_id and sender_item_id", async () => {
    const rid = newRequest();
    vi.mocked(sendPayout).mockResolvedValue(sent());

    const res = await approve(rid);
    expect(res).toMatchObject({ status: 200, json: { status: "sent", payoutStatus: "PENDING", batchId: "BATCH-1" } });
    expect(sendPayout).toHaveBeenCalledWith(expect.objectContaining({ senderBatchId: rid, senderItemId: rid, email: "jordan@example.com", cents: 2350 }));

    // Approving again does not send a second payout.
    expect((await approve(rid, "Sam Ortiz")).status).toBe(200);
    expect(sendPayout).toHaveBeenCalledTimes(1);
  });

  it("only lets an officer or the treasurer on the roster approve", async () => {
    const rid = newRequest();
    expect((await approve(rid, "Marcus Hill")).status).toBe(403);
    expect((await approve(rid, "Someone Else")).status).toBe(400);
    expect((await approve(rid, "Jordan Lee")).status).toBe(403);
    expect(sendPayout).not.toHaveBeenCalled();

    const own = createReimbursement({ nightId, requester: "Pat Okafor", payeeEmail: "pat@example.com", cents: 500, memo: "Ice" });
    expect((await approve(own, "pat okafor ")).status).toBe(400);
  });

  it("records a payout with no answer as unknown, then settles it under the same sender_batch_id", async () => {
    const rid = newRequest();
    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "unknown", error: networkError() });

    const first = await approve(rid);
    expect(first.status).toBe(202);
    expect(getReimbursement(rid)).toMatchObject({ status: "requested", payoutStatus: PAYOUT_UNKNOWN, batchId: null });

    // Approving again is refused; the card offers Check with PayPal instead.
    expect((await approve(rid, "Sam Ortiz")).status).toBe(409);

    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "unknown", error: networkError() });
    expect((await refresh(rid)).status).toBe(503);
    expect(getReimbursement(rid)?.payoutStatus).toBe(PAYOUT_UNKNOWN);

    vi.mocked(sendPayout).mockResolvedValueOnce(sent({ status: "SUCCESS" }));
    const settled = await refresh(rid);
    expect(settled).toEqual({ status: 200, json: { status: "sent", payoutStatus: "SUCCESS" } });
    expect(vi.mocked(sendPayout).mock.calls.map((c) => c[0].senderBatchId)).toEqual([rid, rid, rid]);
    expect(getReimbursement(rid)).toMatchObject({ batchId: "BATCH-1", itemId: "ITEM-1", error: null });
  });

  it("treats PayPal's duplicate sender_batch_id answer as already sent, never as a failure", async () => {
    const rid = newRequest();
    vi.mocked(sendPayout).mockResolvedValue({ kind: "duplicate" });
    expect((await approve(rid)).status).toBe(202);
    expect(getReimbursement(rid)).toMatchObject({ status: "requested", payoutStatus: PAYOUT_UNKNOWN });
  });

  const businessError = () => new PayPalError("User business error.", 400, "USER_BUSINESS_ERROR", "SOMETHING_UNFAMILIAR", null);

  it("keeps a re-sent try unconfirmed when PayPal refuses it in a way that doesn't rule out the first send", async () => {
    const rid = newRequest();
    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "unknown", error: networkError() });
    expect((await approve(rid)).status).toBe(202);

    for (const error of [businessError(), new PayPalError("Insufficient funds", 422, "INSUFFICIENT_FUNDS", null, null), new PayPalError("Too many requests", 429, "RATE_LIMIT_REACHED", null, null)]) {
      vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "rejected", error });
      const res = await refresh(rid);
      expect(res.status).toBe(502);
      expect(String(res.json.error)).toContain(error.message);
      expect(getReimbursement(rid)).toMatchObject({ status: "requested", payoutStatus: PAYOUT_UNKNOWN, batchId: null });
    }

    // Still no way to send it under a new sender_batch_id.
    expect((await retry(rid, { approver: "Sam Ortiz" })).status).toBe(409);
    expect((await approve(rid, "Sam Ortiz")).status).toBe(409);
    expect(vi.mocked(sendPayout).mock.calls.map((c) => c[0].senderBatchId)).toEqual([rid, rid, rid, rid]);
    expect(listAudit(nightId).filter((a) => a.action === "reimbursement.payout_unclear")).toHaveLength(3);
  });

  it("marks a re-sent try failed when PayPal says the request itself is invalid", async () => {
    const rid = newRequest();
    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "unknown", error: networkError() });
    await approve(rid);

    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "rejected", error: new PayPalError("Invalid request - see details", 400, "VALIDATION_ERROR", "INVALID_EMAIL", null) });
    expect((await refresh(rid)).status).toBe(502);
    expect(getReimbursement(rid)).toMatchObject({ status: "failed", payoutStatus: null, error: "Invalid request - see details" });
  });

  it("keeps a try left over from a stopped server unconfirmed on an unfamiliar refusal at approval", async () => {
    const rid = newRequest();
    audit(nightId, "Pat Okafor", "reimbursement.payout_attempt", { id: rid, attempt: 1, senderBatchId: rid, email: "jordan@example.com", cents: 2350 });
    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "rejected", error: businessError() });
    expect((await approve(rid)).status).toBe(202);
    expect(getReimbursement(rid)).toMatchObject({ status: "requested", payoutStatus: PAYOUT_UNKNOWN });
  });

  it("marks a first try failed on any refusal, since nothing could have been sent before it", async () => {
    const rid = newRequest();
    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "rejected", error: businessError() });
    expect((await approve(rid)).status).toBe(502);
    expect(getReimbursement(rid)?.status).toBe("failed");
  });

  it("retries a definite failure with a fresh sender_batch_id and a corrected email", async () => {
    const rid = newRequest();
    vi.mocked(sendPayout).mockResolvedValueOnce({ kind: "rejected", error: new PayPalError("Receiver is invalid", 422, "UNPROCESSABLE_ENTITY", "RECEIVER_INVALID", null) });
    expect((await approve(rid)).status).toBe(502);
    expect(getReimbursement(rid)).toMatchObject({ status: "failed", batchId: null, error: "Receiver is invalid" });

    // Not the requester, and only after a failure.
    expect((await retry(rid, { approver: "Jordan Lee" })).status).toBe(403);
    expect((await retry(rid, { approver: "Sam Ortiz", payeeEmail: "not-an-email" })).status).toBe(400);

    vi.mocked(sendPayout).mockResolvedValueOnce(sent({ batchId: "BATCH-2", itemId: "ITEM-2" }));
    const res = await retry(rid, { approver: "Sam Ortiz", payeeEmail: "jordan.lee@example.com" });
    expect(res).toMatchObject({ status: 200, json: { status: "sent", batchId: "BATCH-2" } });
    expect(vi.mocked(sendPayout).mock.calls[1]?.[0]).toMatchObject({ senderBatchId: `${rid}-2`, senderItemId: rid, email: "jordan.lee@example.com" });
    expect(getReimbursement(rid)).toMatchObject({ status: "sent", payeeEmail: "jordan.lee@example.com", approver: "Sam Ortiz", error: null });

    expect((await retry(rid, { approver: "Sam Ortiz" })).status).toBe(409);
  });

  it("uses a new sender_batch_id for each try after a payout comes back", async () => {
    const rid = newRequest();
    updateReimbursement(rid, { status: "failed", approver: "Pat Okafor", batchId: "BATCH-1", itemId: "ITEM-1", payoutStatus: "RETURNED" });
    vi.mocked(sendPayout).mockResolvedValueOnce(sent({ batchId: "BATCH-2", status: "RETURNED" }));
    await retry(rid, { approver: "Dana Reyes" });
    expect(getReimbursement(rid)).toMatchObject({ status: "failed", batchId: "BATCH-2" });

    vi.mocked(sendPayout).mockResolvedValueOnce(sent({ batchId: "BATCH-3" }));
    await retry(rid, { approver: "Dana Reyes" });
    expect(vi.mocked(sendPayout).mock.calls.map((c) => c[0].senderBatchId)).toEqual([`${rid}-2`, `${rid}-3`]);
  });

  it("refreshes a sent payout from its item", async () => {
    const rid = newRequest();
    updateReimbursement(rid, { status: "sent", approver: "Pat Okafor", batchId: "BATCH-1", itemId: "ITEM-1", payoutStatus: "PENDING" });
    vi.mocked(getPayoutItem).mockResolvedValue({ itemId: "ITEM-1", batchId: "BATCH-1", status: "FAILED", transactionId: null, error: "Receiver account is locked" });
    expect(await refresh(rid)).toEqual({ status: 200, json: { status: "failed", payoutStatus: "FAILED" } });
    expect(getReimbursement(rid)?.error).toBe("Receiver account is locked");
  });

  it("refuses payouts for sample games", async () => {
    const rid = createReimbursement({ nightId: "night_sample_1010", requester: "Jordan Lee", payeeEmail: "j@example.com", cents: 100, memo: "x" });
    expect((await approve(rid)).status).toBe(409);
    expect(sendPayout).not.toHaveBeenCalled();
  });
});

describe("sendPayout", () => {
  it("classifies PayPal's answers", async () => {
    const { sendPayout: realSend } = await vi.importActual<typeof import("@/lib/paypal/payouts")>("@/lib/paypal/payouts");
    const input = { senderBatchId: "reimb_1", senderItemId: "reimb_1", email: "a@example.com", cents: 100, note: "n" };
    const fetchMock = vi.mocked(paypalFetch);

    // Duplicate with a link to the existing batch: read the batch instead of failing.
    fetchMock.mockRejectedValueOnce(new PayPalError("User business error.", 400, "USER_BUSINESS_ERROR", "Batch with given sender_batch_id already exists", null, [
      "https://api.sandbox.paypal.com/v1/payments/payouts/KXUZXA8JJW8G8",
    ]));
    fetchMock.mockResolvedValueOnce({
      batch_header: { payout_batch_id: "KXUZXA8JJW8G8", batch_status: "SUCCESS" },
      items: [{ payout_item_id: "MEEXVK2YXWBRE", payout_batch_id: "KXUZXA8JJW8G8", transaction_status: "UNCLAIMED" }],
    });
    await expect(realSend(input)).resolves.toEqual({ kind: "sent", batchId: "KXUZXA8JJW8G8", itemId: "MEEXVK2YXWBRE", status: "UNCLAIMED", error: null });

    fetchMock.mockRejectedValueOnce(new PayPalError("User business error.", 400, "USER_BUSINESS_ERROR", "Batch with given sender_batch_id already exists", null));
    await expect(realSend(input)).resolves.toEqual({ kind: "duplicate" });

    fetchMock.mockRejectedValueOnce(networkError());
    await expect(realSend(input)).resolves.toMatchObject({ kind: "unknown" });

    fetchMock.mockRejectedValueOnce(new PayPalError("Server error", 500, "INTERNAL_SERVER_ERROR", null, null));
    await expect(realSend(input)).resolves.toMatchObject({ kind: "unknown" });

    fetchMock.mockRejectedValueOnce(new PayPalError("Insufficient funds", 422, "INSUFFICIENT_FUNDS", null, null));
    await expect(realSend(input)).resolves.toMatchObject({ kind: "rejected" });
  });

  it("only treats an invalid request as ruling out an earlier send of the same try", () => {
    expect(rejectsEarlierSend(new PayPalError("Invalid request - see details", 400, "VALIDATION_ERROR", null, null))).toBe(true);
    expect(rejectsEarlierSend(new PayPalError("User business error.", 400, "USER_BUSINESS_ERROR", null, null))).toBe(false);
    expect(rejectsEarlierSend(new PayPalError("Insufficient funds", 422, "INSUFFICIENT_FUNDS", null, null))).toBe(false);
    expect(rejectsEarlierSend(new PayPalError("Unauthorized", 401, "AUTHENTICATION_FAILURE", null, null))).toBe(false);
  });
});

describe("viewOrder", () => {
  const usd = (value: string) => ({ currencyCode: "USD", value });
  const order = (captures: { id: string; status: string }[]) =>
    ({
      id: "7AR09505JL644645L",
      status: "COMPLETED",
      paymentSource: { venmo: { emailAddress: "fan@example.com" } },
      purchaseUnits: [
        {
          referenceId: nightId,
          customId: `${nightId}:window`,
          invoiceId: `${nightId}-J8F`,
          amount: usd("7.00"),
          items: [
            { name: "Hot Dog (all beef)", quantity: "2", unitAmount: usd("3.00"), sku: "hotdog" },
            { name: "Water", quantity: "1", unitAmount: usd("1.00"), sku: "water" },
          ],
          payments: { captures: captures.map((c) => ({ ...c, amount: usd("7.00") })) },
        },
      ],
    }) as unknown as Order;

  it("maps a Venmo order and picks the capture that took the money", () => {
    const v = viewOrder(order([{ id: "CAP-DECLINED", status: "DECLINED" }, { id: "CAP-OK", status: "COMPLETED" }]), listItems());
    expect(v).toMatchObject({
      captureId: "CAP-OK", captureStatus: "COMPLETED", captureCents: 700, totalCents: 700, funding: "venmo", payer: "fan@example.com",
      items: LINES,
    });
  });

  it("still finds a capture after it was refunded, even when a declined one came later", () => {
    const v = viewOrder(order([{ id: "CAP-OK", status: "REFUNDED" }, { id: "CAP-DECLINED", status: "DECLINED" }]), listItems());
    expect(v).toMatchObject({ captureId: "CAP-OK", captureStatus: "REFUNDED" });
  });
});
