import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "../lib/db";
import { isCashBlind, redactNightState, type ClientNightState } from "../lib/redact";
import {
  addCashCount, createNight, createReimbursement, getLedger, getNightState, insertOrder, markOrderCompleted, saveCount, saveDeposit,
  setNightStatus,
} from "../lib/repo";
import { seedDemo } from "../lib/seed";
import { GET as getNight } from "../app/api/nights/[id]/route";
import { GET as getPhotoRoute } from "../app/api/photos/[sha]/route";
import { savePhoto } from "../lib/photos";

// Counted totals chosen so they can't collide with any other number in the payload.
const FIRST_COUNT = 98_761;
const OPEN = { water: 24, sports: 12, chips: 20, candy: 18, hotdog: 16 };
const CLOSE = { water: 20, sports: 12, chips: 18, candy: 18, hotdog: 10 };

let dir: string;
let nightId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-redact-"));
  process.env.HALFTIME_DB = path.join(dir, "test.db");
  process.env.HALFTIME_PHOTOS = path.join(dir, "photos");
  resetDbForTests();
  seedDemo(true);
  nightId = createNight({ title: "Redaction test game", date: "2026-11-14", floatCents: 10_000 });
  saveCount({ nightId, kind: "open", counts: OPEN, countedBy: "Marcus Hill", checkedBy: "Priya Shah" });
  setNightStatus(nightId, "selling");
  insertOrder({ id: "5O190127TN364715T", nightId, booth: "window", code: "K7A", items: [], totalCents: 0 });
  markOrderCompleted("5O190127TN364715T", {
    captureId: "3C679366HH908993F",
    items: [{ sku: "hotdog", name: "Hot dog", quantity: 2, unitCents: 300 }, { sku: "water", name: "Water", quantity: 1, unitCents: 100 }],
    totalCents: 700,
    payer: "buyer@example.com",
    funding: "venmo",
  });
  saveCount({ nightId, kind: "close", counts: CLOSE, waste: {}, countedBy: "Jordan Lee", checkedBy: "Priya Shah" });
  setNightStatus(nightId, "closing");
});

afterEach(() => {
  resetDbForTests();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.HALFTIME_PHOTOS;
});

async function fetchNight(): Promise<ClientNightState> {
  const res = await getNight(new Request(`http://localhost/api/nights/${nightId}`), { params: Promise.resolve({ id: nightId }) });
  expect(res.status).toBe(200);
  return (await res.json()) as ClientNightState;
}

describe("isCashBlind", () => {
  it("is blind only while closing and the counts don't agree", () => {
    expect(isCashBlind("closing", "missing")).toBe(true);
    expect(isCashBlind("closing", "single")).toBe(true);
    expect(isCashBlind("closing", "disagree")).toBe(true);
    expect(isCashBlind("closing", "agree")).toBe(false);
    expect(isCashBlind("closed", "agree")).toBe(false);
    expect(isCashBlind("deposited", "agree")).toBe(false);
    expect(isCashBlind("selling", "missing")).toBe(false);
  });
});

describe("GET /api/nights/[id] during the blind count", () => {
  it("has the numbers to hide in the first place", () => {
    // Guards the test itself: the unredacted state does carry the expected cash.
    addCashCount(nightId, "Jordan Lee", FIRST_COUNT);
    const full = getNightState(nightId)!;
    expect(full.recon.expectedBoxCents).not.toBeNull();
    expect(full.cashCounts[0]!.cents).toBe(FIRST_COUNT);
  });

  it("returns no counted total, expected cash, closing count or per-item cash after the first count", async () => {
    addCashCount(nightId, "Jordan Lee", FIRST_COUNT);
    const s = await fetchNight();
    expect(s.cashHidden).toBe(true);
    expect(s.cashCounts).toEqual([expect.objectContaining({ countedBy: "Jordan Lee", cents: null })]);
    expect(s.recon.cash).toMatchObject({ status: "single", countedCents: null, counts: [] });
    expect(s.recon.expectedCashSalesCents).toBeNull();
    expect(s.recon.expectedBoxCents).toBeNull();
    expect(s.recon.totalSalesCents).toBeNull();
    expect(s.recon.cashUnits).toBeNull();
    expect(s.recon.soldUnits).toBeNull();
    expect(s.close?.counts).toBeNull();
    expect(s.close?.countedBy).toBe("Jordan Lee");
    for (const l of s.recon.lines) {
      expect(l).toMatchObject({ close: null, sold: null, cashUnits: null, cashCents: null });
    }
    expect(JSON.stringify(s)).not.toContain(String(FIRST_COUNT));
  });

  it("stays hidden when the two counts are different", async () => {
    addCashCount(nightId, "Jordan Lee", FIRST_COUNT);
    addCashCount(nightId, "Priya Shah", FIRST_COUNT + 500);
    const s = await fetchNight();
    expect(s.recon.cash.status).toBe("disagree");
    expect(s.cashHidden).toBe(true);
    expect(s.cashCounts.every((c) => c.cents === null)).toBe(true);
    expect(s.recon.expectedBoxCents).toBeNull();
  });

  it("shows everything once two people's counts agree", async () => {
    addCashCount(nightId, "Jordan Lee", FIRST_COUNT);
    addCashCount(nightId, "Priya Shah", FIRST_COUNT);
    const s = await fetchNight();
    expect(s.cashHidden).toBe(false);
    expect(s.recon.cash.countedCents).toBe(FIRST_COUNT);
    expect(s.recon.expectedBoxCents).toBe(getNightState(nightId)!.recon.expectedBoxCents);
    expect(s.close?.counts).toEqual(CLOSE);
    expect(s.cashCounts.map((c) => c.cents)).toEqual([FIRST_COUNT, FIRST_COUNT]);
  });

  it("never includes buyer emails, capture ids or roster emails", async () => {
    const full = getNightState(nightId)!;
    const finished = redactNightState({ ...full, night: { ...full.night, status: "deposited" } });
    for (const night of [await fetchNight(), finished]) {
      const json = JSON.stringify(night);
      expect(json).not.toContain("buyer@example.com");
      expect(json).not.toContain("3C679366HH908993F");
      expect(night.orders[0]).toMatchObject({ id: "5O190127TN364715T", code: "K7A", payer: null, captureId: null, funding: "venmo" });
      expect(night.people.every((p) => p.email === null)).toBe(true);
    }
  });

  it("never includes payee emails or receipt and deposit slip photo hashes", async () => {
    const receipt = "a".repeat(64);
    const slip = "b".repeat(64);
    createReimbursement({ nightId, requester: "Jordan Lee", payeeEmail: "payee@example.com", cents: 2350, memo: "Buns", receiptSha256: receipt });
    saveDeposit({ nightId, depositor: "Dana Reyes", cents: 12_000, slipSha256: slip });
    const full = getNightState(nightId)!;
    expect(full.reimbursements[0]!.payeeEmail).toBe("payee@example.com");
    expect(full.deposit?.slipSha256).toBe(slip);

    const finished = redactNightState({ ...full, night: { ...full.night, status: "deposited" } });
    for (const night of [await fetchNight(), finished]) {
      const json = JSON.stringify(night);
      for (const secret of ["payee@example.com", receipt, slip]) expect(json).not.toContain(secret);
      expect(night.reimbursements[0]).toMatchObject({ requester: "Jordan Lee", cents: 2350, payeeEmail: null, receiptSha256: null });
      expect(night.deposit).toMatchObject({ depositor: "Dana Reyes", cents: 12_000, slipSha256: null });
    }
  });

  it("returns 404 for an unknown game", async () => {
    const res = await getNight(new Request("http://localhost/api/nights/nope"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});

describe("season ledger during the blind count", () => {
  const row = () => getLedger().find((r) => r.nightId === nightId)!;

  it("hides the expected cash and total sales until both counts are in", () => {
    expect(row()).toMatchObject({ status: "closing", cashHidden: true, expectedCashSalesCents: null, expectedBoxCents: null, totalSalesCents: null });
    addCashCount(nightId, "Jordan Lee", FIRST_COUNT);
    expect(row()).toMatchObject({ cashHidden: true, expectedBoxCents: null, countedCents: null, cashVarianceCents: null });
  });

  it("shows them once the counts agree, and for finished games", () => {
    addCashCount(nightId, "Jordan Lee", FIRST_COUNT);
    addCashCount(nightId, "Priya Shah", FIRST_COUNT);
    const r = row();
    expect(r.cashHidden).toBe(false);
    expect(r.expectedBoxCents).not.toBeNull();
    expect(r.totalSalesCents).not.toBeNull();
    expect(r.countedCents).toBe(FIRST_COUNT);
    // The sample games are all deposited and keep their numbers.
    expect(getLedger().filter((l) => l.sample).every((l) => !l.cashHidden && l.totalSalesCents !== null)).toBe(true);
  });
});

describe("GET /api/photos/[sha]", () => {
  it("lets only the browser cache a photo, never a shared cache", async () => {
    const { sha256 } = savePhoto(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "image/jpeg");
    const get = (headers?: HeadersInit) =>
      getPhotoRoute(new Request(`http://localhost/api/photos/${sha256}`, { headers }), { params: Promise.resolve({ sha: sha256 }) });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const again = await get({ "if-none-match": `"${sha256}"` });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toMatch(/^private,/);
  });
});
