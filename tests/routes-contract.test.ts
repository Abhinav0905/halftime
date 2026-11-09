// Behaviour that docs/api-contract.md promises and no other test pins down:
// the webhook route's 400/413/503 answers, the shared photo-id check on the
// deposit and reimbursement routes, and the "not on sale tonight" order rule.
// PayPal is never called: paypalFetch is mocked and orders are offline demo orders.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/paypal/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal/client")>()),
  paypalFetch: vi.fn(),
}));

import { POST as postCounts } from "@/app/api/nights/[id]/counts/route";
import { POST as postDeposit } from "@/app/api/nights/[id]/deposit/route";
import { POST as postReimbursement } from "@/app/api/nights/[id]/reimbursements/route";
import { POST as postOrder } from "@/app/api/orders/route";
import { POST as postWebhook } from "@/app/api/paypal/webhook/route";
import { db, resetDbForTests } from "@/lib/db";
import { PayPalError, paypalFetch } from "@/lib/paypal/client";
import { createNight } from "@/lib/repo";
import { seedDemo } from "@/lib/seed";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, id: string, body: unknown) {
  const req = new Request("http://halftime.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function webhook(body: string, headers: Record<string, string> = {}) {
  const res = await postWebhook(new Request("http://halftime.test/api/paypal/webhook", { method: "POST", headers, body }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const storedEvents = () => (db().prepare("SELECT COUNT(*) AS c FROM webhook_event").get() as { c: number }).c;

const SIGNED = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "c2lnbmF0dXJl",
  "paypal-transmission-time": "2026-11-09T06:40:00Z",
};

const event = (id = "WH-CONTRACT-1") => JSON.stringify({ id, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "5O190127TN364715T" } });

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-contract-"));
  process.env.HALFTIME_DB = path.join(dir, "test.db");
  resetDbForTests();
  seedDemo(true);
  vi.mocked(paypalFetch).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetDbForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/paypal/webhook", () => {
  it("answers 400 to a body that is not a PayPal event, without calling PayPal", async () => {
    expect((await webhook("not json")).status).toBe(400);
    expect((await webhook(JSON.stringify({ hello: "world" }))).status).toBe(400);
    expect(paypalFetch).not.toHaveBeenCalled();
  });

  it("answers 400 and stores nothing when the server has no webhook id to verify with", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const res = await webhook(event(), SIGNED);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/signature/);
    expect(storedEvents()).toBe(0);
    expect(paypalFetch).not.toHaveBeenCalled();
  });

  it("answers 400 and stores nothing when PayPal says the signature is not genuine", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-ID-1");
    vi.mocked(paypalFetch).mockResolvedValue({ verification_status: "FAILURE" });
    expect((await webhook(event(), SIGNED)).status).toBe(400);
    expect(storedEvents()).toBe(0);
  });

  it("answers 503 and stores nothing when PayPal can't be reached to verify", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-ID-1");
    vi.mocked(paypalFetch).mockRejectedValue(new PayPalError("Could not reach PayPal: timeout", 503, "NETWORK_ERROR", null, null));
    expect((await webhook(event(), SIGNED)).status).toBe(503);
    expect(storedEvents()).toBe(0);
  });

  it("stores a verified event once and reports the repeat as a duplicate", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-ID-1");
    vi.mocked(paypalFetch).mockResolvedValue({ verification_status: "SUCCESS" });
    const first = await webhook(event(), SIGNED);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, result: "ignored" });
    const again = await webhook(event(), SIGNED);
    expect(again.json).toMatchObject({ ok: true, result: "duplicate" });
    expect(storedEvents()).toBe(1);
  });

  it("answers 413 to an event over 64 KB", async () => {
    const big = JSON.stringify({ id: "WH-BIG", event_type: "X", resource: { pad: "x".repeat(70 * 1024) } });
    expect((await webhook(big)).status).toBe(413);
  });
});

describe("photo ids on deposit and reimbursement requests", () => {
  const upper = "A".repeat(64);
  const lower = "a".repeat(64);

  it("rejects anything but 64 lowercase hex characters before looking anything up", async () => {
    const deposit = await call(postDeposit, "night_missing", { depositor: "Dana Reyes", cents: 100, slipSha256: upper });
    expect(deposit.status).toBe(400);
    expect(deposit.json.error).toBe("slipSha256: expected a 64-character photo id");

    const reimb = await call(postReimbursement, "night_missing", {
      requester: "Priya Shah", payeeEmail: "priya@example.com", cents: 500, memo: "Buns", receiptSha256: "abc123",
    });
    expect(reimb.status).toBe(400);
    expect(reimb.json.error).toBe("receiptSha256: expected a 64-character photo id");
  });

  it("accepts a well-formed id and then asks for the photo to be uploaded", async () => {
    const nightId = createNight({ title: "vs. Eastside", date: "2026-11-14", floatCents: 10_000 });
    const reimb = await call(postReimbursement, nightId, {
      requester: "Priya Shah", payeeEmail: "priya@example.com", cents: 500, memo: "Buns", receiptSha256: lower,
    });
    expect(reimb.status).toBe(400);
    expect(reimb.json.error).toBe("Upload the receipt photo first.");
  });
});

describe("POST /api/orders and the opening count", () => {
  it("doesn't sell an item that had an opening count of zero", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const nightId = createNight({ title: "vs. Eastside", date: "2026-11-14", floatCents: 10_000 });
    const open = await call(postCounts, nightId, {
      kind: "open", counts: { water: 8, sports: 0, chips: 7, candy: 5, hotdog: 4 }, countedBy: "Marcus Hill", checkedBy: "Priya Shah",
    });
    expect(open.status).toBe(200);

    const order = (cart: Record<string, number>) =>
      postOrder(new Request("http://halftime.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nightId, cart }),
      }));

    const refused = await order({ water: 1, sports: 1 });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("Sports drink isn't on sale tonight.");

    const fine = await order({ water: 1, sports: 0 });
    expect(fine.status).toBe(201);
    expect(await fine.json()).toMatchObject({ totalCents: 100, simulated: true });
  });
});
