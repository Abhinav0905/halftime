// Close-out routes called directly with Request objects against a throwaway database.
// PayPal is never called: live-night orders here are offline demo (SIM-) orders.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/paypal/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal/orders")>()),
  refundCapture: vi.fn(() => {
    throw new Error("PayPal must not be called from these tests.");
  }),
}));

import { POST as postCash } from "@/app/api/nights/[id]/cash/route";
import { POST as postCounts } from "@/app/api/nights/[id]/counts/route";
import { POST as postDeposit } from "@/app/api/nights/[id]/deposit/route";
import { POST as postFinalize } from "@/app/api/nights/[id]/finalize/route";
import { POST as postReimbursement } from "@/app/api/nights/[id]/reimbursements/route";
import { POST as postRefund } from "@/app/api/orders/[id]/refund/route";
import ClosePage from "@/app/nights/[id]/close/page";
import CountPage from "@/app/nights/[id]/count/[kind]/page";
import { CountFlow } from "@/app/nights/[id]/count/[kind]/CountFlow";
import { CashCountForm } from "@/components/CloseOutForms";
import { LinkButton } from "@/components/ui";
import { resetDbForTests } from "@/lib/db";
import { checkCashCounter, checkCashCounterNotCloser, checkCountPeople, checkDepositor } from "@/lib/engine/rules";
import { findPerson } from "@/lib/roster";
import {
  createNight, getCounts, getDeposit, getNight, insertOrder, listCashCounts, listNotices, listNights, listReimbursements,
  markOrderCompleted, reconcileNight,
} from "@/lib/repo";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { seedDemo } from "@/lib/seed";

const OPEN = { water: 24, sports: 12, chips: 20, candy: 18, hotdog: 16 };
// Sold: 4 water, 6 hot dogs. PayPal paid for 1 water and 2 hot dogs, so cash is 3 × $1 + 4 × $3 = $15.
const CLOSE = { water: 20, sports: 12, chips: 20, candy: 18, hotdog: 10 };
const EXPECTED_BOX = 1500 + 10_000;
const LINES = [
  { sku: "hotdog", name: "Hot dog", quantity: 2, unitCents: 300 },
  { sku: "water", name: "Water", quantity: 1, unitCents: 100 },
];
const ORDER_ID = "SIM-closeout-test";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request("http://halftime.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const count = (id: string, kind: "open" | "close", counts: Record<string, number>, countedBy = "Jordan Lee", checkedBy = "Marcus Hill") =>
  call(postCounts, id, { kind, counts, countedBy, checkedBy });
const cash = (id: string, countedBy: string, cents: number) => call(postCash, id, { countedBy, cents });

let dir: string;
let nightId: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-closeout-"));
  process.env.HALFTIME_DB = path.join(dir, "test.db");
  resetDbForTests();
  seedDemo(true);
  nightId = createNight({ title: "vs. Eastside", date: "2026-11-14", floatCents: 10_000 });
  expect((await count(nightId, "open", OPEN, "Marcus Hill", "Priya Shah")).status).toBe(200);
  insertOrder({ id: ORDER_ID, nightId, booth: "window", code: "K7A", items: LINES, totalCents: 700, simulated: true });
  markOrderCompleted(ORDER_ID, { captureId: `SIMCAP-${ORDER_ID}`, items: LINES, totalCents: 700, payer: null, funding: null });
});

afterEach(() => {
  resetDbForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function toClosing() {
  expect((await count(nightId, "close", CLOSE)).status).toBe(200);
}

async function toClosed(countedCents = EXPECTED_BOX) {
  await toClosing();
  expect((await cash(nightId, "Priya Shah", countedCents)).status).toBe(200);
  expect((await cash(nightId, "Pat Okafor", countedCents)).status).toBe(200);
  expect((await call(postFinalize, nightId, { by: "Sam Ortiz" })).status).toBe(200);
}

describe("opening count", () => {
  it("is still locked once a PayPal order is paid", async () => {
    const res = await count(nightId, "open", OPEN, "Marcus Hill", "Priya Shah");
    expect(res).toEqual({ status: 409, json: { error: "Sales have started, so the opening count is locked." } });
  });
});

describe("closing count", () => {
  it("can be saved again before the cash is counted", async () => {
    await toClosing();
    expect((await count(nightId, "close", { ...CLOSE, hotdog: 11 })).status).toBe(200);
    expect(getCounts(nightId).close?.counts.hotdog).toBe(11);
  });

  it("is locked once the first cash count is in", async () => {
    await toClosing();
    await cash(nightId, "Priya Shah", 11_000);
    const res = await count(nightId, "close", { ...CLOSE, hotdog: 6 });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/cash box has been counted, so the closing count is locked/);
    expect(getCounts(nightId).close?.counts.hotdog).toBe(10);
  });

  it("stays locked after the counts agree, so leftovers can't be changed to cover a shortfall", async () => {
    await toClosing();
    await cash(nightId, "Priya Shah", 10_300);
    await cash(nightId, "Pat Okafor", 10_300);
    // Raising the hot dog leftovers by 4 would hide the $12.00 shortfall.
    expect((await count(nightId, "close", { ...CLOSE, hotdog: 14 })).status).toBe(409);
    expect(reconcileNight(getNight(nightId)!).cashVarianceCents).toBe(-1200);
  });
});

describe("cash counts", () => {
  it("can't be added after two counts agree", async () => {
    await toClosing();
    await cash(nightId, "Priya Shah", 10_300);
    await cash(nightId, "Pat Okafor", 10_300);
    for (const who of ["Sam Ortiz", "Dana Reyes"]) {
      const res = await cash(nightId, who, EXPECTED_BOX);
      expect(res.status).toBe(409);
      expect(res.json.error).toMatch(/already match/);
    }
    expect(listCashCounts(nightId)).toHaveLength(2);

    expect((await call(postFinalize, nightId, { by: "Sam Ortiz" })).status).toBe(200);
    const [notice] = listNotices(nightId);
    expect(notice).toMatchObject({ level: "red", title: "Cash box is $12.00 short of expected" });
    expect(notice!.body).toContain("Two volunteers (Priya Shah and Pat Okafor) counted $103.00");
  });

  it("agree when a third volunteer matches the first", async () => {
    await toClosing();
    await cash(nightId, "Priya Shah", 11_000);
    expect((await cash(nightId, "Pat Okafor", 10_900)).json.cash).toEqual({ status: "disagree", countedCents: null });
    expect((await cash(nightId, "Dana Reyes", 11_000)).json.cash).toEqual({ status: "agree", countedCents: 11_000 });
    expect((await call(postFinalize, nightId, { by: "Sam Ortiz" })).status).toBe(200);
    // The notice names the two people whose totals matched, not the last two counters.
    expect(listNotices(nightId)[0]?.body).toContain("Two volunteers (Priya Shah and Dana Reyes) counted $110.00");
  });

  it("don't agree when the same person repeats their own total", async () => {
    await toClosing();
    await cash(nightId, "Priya Shah", 11_400);
    await cash(nightId, "Pat Okafor", 11_300);
    expect((await cash(nightId, "Priya Shah", 11_400)).json.cash).toEqual({ status: "disagree", countedCents: null });
    const res = await call(postFinalize, nightId, { by: "Sam Ortiz" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/cash counts are different/);
  });

  it("can't be done by either volunteer who did the closing count", async () => {
    await toClosing();
    for (const who of ["Jordan Lee", "marcus  HILL"]) {
      const res = await cash(nightId, who, EXPECTED_BOX);
      expect(res).toEqual({
        status: 400,
        json: { error: "The two volunteers who did the closing count can't count the cash. Ask someone else to count it." },
      });
    }
    expect(listCashCounts(nightId)).toHaveLength(0);
    await cash(nightId, "Priya Shah", 11_000);
    await cash(nightId, "Pat Okafor", 10_900);
    // Still barred when a third count is needed.
    expect((await cash(nightId, "Jordan Lee", 11_000)).status).toBe(400);
    expect((await cash(nightId, "Sam Ortiz", 11_000)).json.cash).toEqual({ status: "agree", countedCents: 11_000 });
  });

  it("need a roster name, compared the way the roster spells it", async () => {
    await toClosing();
    expect((await cash(nightId, "Somebody Else", 100)).status).toBe(400);
    expect((await cash(nightId, "  priya   SHAH ", 11_500)).status).toBe(200);
    expect(listCashCounts(nightId)[0]?.countedBy).toBe("Priya Shah");
    const again = await cash(nightId, "Priya  Shah", 11_500);
    expect(again).toEqual({ status: 400, json: { error: "The next cash count has to be done by a different volunteer." } });
  });
});

describe("names on the other close-out steps", () => {
  it("a count can't be checked by the same person typed differently", async () => {
    const res = await count(nightId, "close", CLOSE, "Marcus Hill", "marcus  hill");
    expect(res).toEqual({ status: 400, json: { error: "A second volunteer has to check the count." } });
    expect((await count(nightId, "close", CLOSE, "Marcus Hill", "Nobody Here")).status).toBe(400);
  });

  it("counts are stored under the roster spelling", async () => {
    expect((await count(nightId, "close", CLOSE, " marcus   HILL ", "priya shah")).status).toBe(200);
    expect(getCounts(nightId).close).toMatchObject({ countedBy: "Marcus Hill", checkedBy: "Priya Shah" });
  });

  it("finalize needs a roster name", async () => {
    await toClosing();
    await cash(nightId, "Priya Shah", EXPECTED_BOX);
    await cash(nightId, "Pat Okafor", EXPECTED_BOX);
    expect((await call(postFinalize, nightId, { by: "A Parent" })).status).toBe(400);
    expect((await call(postFinalize, nightId, { by: "sam ortiz" })).status).toBe(200);
  });

  it("the deposit can't be made by a cash counter under another spelling", async () => {
    await toClosed();
    const res = await call(postDeposit, nightId, { depositor: "priya  SHAH", cents: 1500 });
    expect(res).toEqual({ status: 400, json: { error: "The deposit should be made by someone who did not count the cash." } });
    expect((await call(postDeposit, nightId, { depositor: "dana reyes", cents: 1500 })).status).toBe(200);
    expect(getDeposit(nightId)?.depositor).toBe("Dana Reyes");
  });

  it("reimbursement requests need a roster name and are closed on sample games", async () => {
    const body = { payeeEmail: "pat@example.com", cents: 2500, memo: "Hot dog buns" };
    expect((await call(postReimbursement, nightId, { ...body, requester: "Nobody" })).status).toBe(400);
    expect((await call(postReimbursement, nightId, { ...body, requester: "pat okafor" })).status).toBe(201);
    expect(listReimbursements(nightId)[0]?.requester).toBe("Pat Okafor");
    const sample = await call(postReimbursement, "night_sample_1010", { ...body, requester: "Pat Okafor" });
    expect(sample.status).toBe(409);
    expect(listReimbursements("night_sample_1010")).toHaveLength(0);
  });
});

describe("refunds", () => {
  it("leave sample games as recorded", async () => {
    const before = reconcileNight(getNight("night_sample_1010")!);
    const notices = listNotices().length;
    const res = await call(postRefund, "SAMPLE-1010-001", { by: "Pat Okafor" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/Sample games are read-only/);
    expect(reconcileNight(getNight("night_sample_1010")!).cashVarianceCents).toBe(before.cashVarianceCents);
    expect(listNotices()).toHaveLength(notices);
  });

  it("need a roster name", async () => {
    expect((await call(postRefund, ORDER_ID, { by: "A Fan" })).status).toBe(400);
  });

  it("are still possible after close-out, and tell the officers", async () => {
    await toClosed();
    expect((await call(postDeposit, nightId, { depositor: "Dana Reyes", cents: 1500 })).status).toBe(200);
    expect(listNotices(nightId)).toHaveLength(0);

    const res = await call(postRefund, ORDER_ID, { by: "Dana Reyes" });
    expect(res).toEqual({ status: 200, json: { status: "REFUNDED", refundId: `SIMREF-${ORDER_ID}` } });
    // Two hot dogs and a water move to the cash column.
    expect(reconcileNight(getNight(nightId)!).expectedBoxCents).toBe(EXPECTED_BOX + 700);
    const [notice] = listNotices(nightId);
    expect(notice?.title).toBe("PayPal order K7A was refunded after close-out");
    expect(notice?.body).toContain("Order K7A ($7.00)");
  });
});

describe("deposit when the box held less than the float", () => {
  it("expects nothing at the bank and says so plainly", async () => {
    await toClosed(5000);
    expect((await call(postDeposit, nightId, { depositor: "Dana Reyes", cents: 5000 })).json).toMatchObject({ depositVarianceCents: 5000, band: "red" });
    const deposit = listNotices(nightId).find((n) => n.title.startsWith("Deposit"));
    expect(deposit?.title).toBe("Deposit of $50.00 recorded when no deposit was expected");
    expect(deposit?.body).toContain("less than the $100.00 float");
    expect(deposit?.body).not.toMatch(/−|-\$/);
  });

  it("files no deposit notice for a $0.00 deposit", async () => {
    await toClosed(5000);
    expect((await call(postDeposit, nightId, { depositor: "Dana Reyes", cents: 0 })).json).toMatchObject({ depositVarianceCents: 0, band: "green" });
    expect(listNotices(nightId).filter((n) => n.title.startsWith("Deposit"))).toHaveLength(0);
  });
});

// Server pages return an element tree; walking it (without rendering client components) shows what they would send.
function elements(node: unknown, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement<Record<string, unknown>>(node)) {
    out.push(node);
    for (const v of Object.values(node.props)) elements(v, out);
  }
  return out;
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Record<string, unknown>>(node)) return Object.values(node.props).map(text).join(" ");
  return "";
}
const countPage = async (kind: string) => (await CountPage({ params: Promise.resolve({ id: nightId, kind }) })) as ReactNode;
const closePage = async () => (await ClosePage({ params: Promise.resolve({ id: nightId }) })) as ReactNode;
const recountLinks = (tree: ReactNode) => elements(tree).filter((e) => e.type === LinkButton && e.props.href === `/nights/${nightId}/count/close`);

describe("closing count page", () => {
  it("sends one cap per item PayPal sold, and no opening counts or PayPal units", async () => {
    const flow = elements(await countPage("close")).find((e) => e.type === CountFlow);
    // Opening 16 hot dogs, PayPal sold 2: at most 14 left. Opening 24 water, PayPal sold 1: at most 23.
    expect(flow?.props.caps).toEqual({ hotdog: 14, water: 23 });
    expect(JSON.stringify(flow?.props)).not.toMatch(/"open"|paypal/i);
  });

  it("doesn't send the saved leftovers back for a recount, but keeps the waste", async () => {
    expect((await call(postCounts, nightId, { kind: "close", counts: CLOSE, waste: { chips: 2 }, countedBy: "Jordan Lee", checkedBy: "Marcus Hill" })).status).toBe(200);
    const flow = elements(await countPage("close")).find((e) => e.type === CountFlow);
    expect(flow?.props.initialCounts).toBeNull();
    expect(flow?.props.initialWaste).toMatchObject({ chips: 2 });
  });

  it("is locked with a short message once the first cash count is in", async () => {
    await toClosing();
    await cash(nightId, "Priya Shah", 11_000);
    const tree = await countPage("close");
    expect(elements(tree).some((e) => e.type === CountFlow)).toBe(false);
    expect(text(tree)).toContain("Counts are locked because cash counting has started.");
    expect(text(tree)).toContain("add a note about it when you finalize");
  });
});

describe("close page", () => {
  // 15 hot dogs left means 1 sold, but PayPal recorded 2.
  const OFF = { ...CLOSE, hotdog: 15 };

  it("asks for the recount before the cash count, and keeps the cash form secondary", async () => {
    expect((await count(nightId, "close", OFF)).status).toBe(200);
    const tree = await closePage();
    expect(recountLines(tree)).toBe(1);
    expect(text(tree)).toContain("before anyone counts the cash. Counting the cash locks the closing count.");
    const form = elements(tree).find((e) => e.type === CashCountForm);
    expect(form?.props).toMatchObject({ secondary: true, closers: ["Jordan Lee", "Marcus Hill"] });
  });

  it("hides the recount once cash counting has started", async () => {
    expect((await count(nightId, "close", OFF)).status).toBe(200);
    await cash(nightId, "Priya Shah", 11_000);
    const tree = await closePage();
    expect(recountLines(tree)).toBe(0);
    expect(text(tree)).toContain("The closing count is locked because cash counting has started.");
    expect(elements(tree).find((e) => e.type === CashCountForm)?.props.secondary).toBe(false);
  });

  it("has no recount link when nothing needs a recount", async () => {
    await toClosing();
    expect(recountLines(await closePage())).toBe(0);
  });

  function recountLines(tree: ReactNode) {
    return recountLinks(tree).length;
  }
});

describe("sample season", () => {
  it("follows every separation rule a live game does", () => {
    for (const night of listNights().filter((n) => n.sample)) {
      const { open, close } = getCounts(night.id);
      const cashCounts = listCashCounts(night.id);
      const names = [open!.countedBy, open!.checkedBy, close!.countedBy, close!.checkedBy, ...cashCounts.map((c) => c.countedBy), getDeposit(night.id)!.depositor];
      for (const name of names) expect(findPerson(name)?.name).toBe(name);
      expect(checkCountPeople(open!.countedBy, open!.checkedBy)).toBeNull();
      expect(checkCountPeople(close!.countedBy, close!.checkedBy)).toBeNull();
      cashCounts.forEach((c, i) => {
        expect(checkCashCounterNotCloser(c.countedBy, close)).toBeNull();
        expect(checkCashCounter(c.countedBy, cashCounts.slice(0, i))).toBeNull();
      });
      expect(checkDepositor(getDeposit(night.id)!.depositor, cashCounts.map((c) => c.countedBy))).toBeNull();
    }
  });


  it("has the same notices the app would have filed, each marked as sample", () => {
    const byNight = (id: string) => listNotices(id).map((n) => ({ level: n.level, title: n.title }));
    expect(byNight("night_sample_0926")).toEqual([]);
    expect(byNight("night_sample_1010")).toEqual([{ level: "amber", title: "Cash box is $3.00 short of expected" }]);
    expect(byNight("night_sample_1024")).toEqual([{ level: "red", title: "Deposit is $27.00 lower than the counted cash" }]);

    const sampleIds = new Set(listNights().filter((n) => n.sample).map((n) => n.id));
    const all = listNotices().filter((n) => n.nightId && sampleIds.has(n.nightId));
    expect(all).toHaveLength(2);
    for (const n of all) expect(n.body.endsWith("This is a sample notice.")).toBe(true);
    expect(listNotices("night_sample_1024")[0]?.body).toContain("the vs. Northridge game on Oct 24");
  });

  it("every sample game with an amber or red band has a notice", () => {
    for (const night of listNights().filter((n) => n.sample)) {
      const r = reconcileNight(night);
      const flagged = [r.cashBand, r.depositBand].filter((b) => b === "amber" || b === "red").length;
      expect(listNotices(night.id)).toHaveLength(flagged);
    }
  });
});
