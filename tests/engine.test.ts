import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  band, cashStatus, reconcile, type CatalogLine, type Counts, type OrderForRecon, type ReconcileInput,
} from "../lib/engine/reconcile";

const CATALOG: CatalogLine[] = [
  { sku: "water", name: "Water", priceCents: 100 },
  { sku: "sports", name: "Sports drink", priceCents: 200 },
  { sku: "chips", name: "Chips", priceCents: 100 },
  { sku: "candy", name: "Candy bar", priceCents: 150 },
  { sku: "hotdog", name: "Hot dog", priceCents: 300 },
];
const PRICE = new Map(CATALOG.map((c) => [c.sku, c.priceCents]));

function order(status: string, lines: Record<string, number>): OrderForRecon {
  const items = Object.entries(lines).map(([sku, quantity]) => ({ sku, quantity }));
  return { status, items, totalCents: items.reduce((s, l) => s + l.quantity * (PRICE.get(l.sku) ?? 0), 0) };
}

function input(over: Partial<ReconcileInput>): ReconcileInput {
  return {
    items: CATALOG, open: null, close: null, waste: null, orders: [], floatCents: 10_000,
    cashCounts: [], depositCents: null, toleranceCents: 100, ...over,
  };
}

describe("reconcile: worked example", () => {
  const open = { water: 24, sports: 12, chips: 20, candy: 18, hotdog: 16 };
  const close = { water: 10, sports: 6, chips: 12, candy: 9, hotdog: 4 };
  const orders = [
    order("COMPLETED", { hotdog: 2, water: 1 }),
    order("COMPLETED", { sports: 2, candy: 1 }),
    order("REFUNDED", { hotdog: 3 }),
    order("DECLINED", { chips: 4 }),
  ];

  it("splits each item into PayPal and cash units", () => {
    const r = reconcile(input({ open, close, orders }));
    const hotdog = r.lines.find((l) => l.sku === "hotdog")!;
    expect(hotdog).toMatchObject({ sold: 12, paypalUnits: 2, cashUnits: 10, cashCents: 3000, recount: false });
    const water = r.lines.find((l) => l.sku === "water")!;
    expect(water).toMatchObject({ sold: 14, paypalUnits: 1, cashUnits: 13, cashCents: 1300 });
    // cash: water 13, sports 4, chips 8, candy 8, hotdog 10
    expect(r.expectedCashSalesCents).toBe(1300 + 800 + 800 + 1200 + 3000);
    expect(r.expectedBoxCents).toBe(7100 + 10_000);
    expect(r.paypalCents).toBe(700 + 550);
    expect(r.paypalOrders).toBe(2);
    expect(r.refundedOrders).toBe(1);
  });

  it("compares the agreed cash count with the expected box", () => {
    const counts = [{ countedBy: "Jordan Lee", cents: 14_400 }, { countedBy: "Priya Shah", cents: 14_400 }];
    const r = reconcile(input({ open, close, orders, cashCounts: counts, depositCents: 4400 }));
    expect(r.cash).toMatchObject({ status: "agree", countedCents: 14_400 });
    expect(r.cashVarianceCents).toBe(14_400 - 17_100);
    expect(r.cashBand).toBe("red");
    expect(r.depositExpectedCents).toBe(4400);
    expect(r.depositVarianceCents).toBe(0);
    expect(r.depositBand).toBe("green");
  });

  it("subtracts waste from units sold", () => {
    const r = reconcile(input({ open, close, waste: { hotdog: 2 }, orders }));
    expect(r.lines.find((l) => l.sku === "hotdog")).toMatchObject({ sold: 10, cashUnits: 8, waste: 2 });
  });

  it("asks for a recount when PayPal sold more than the photos show", () => {
    const r = reconcile(input({ open, close: { ...close, sports: 11 }, orders }));
    const sports = r.lines.find((l) => l.sku === "sports")!;
    expect(sports.recount).toBe(true);
    expect(sports.recountReason).toBe("PayPal recorded 2 sold, but the counts show only 1.");
    expect(r.recountSkus).toEqual(["sports"]);
    expect(r.expectedBoxCents).toBeNull();
  });

  it("asks for a recount when the closing count is above the opening count", () => {
    const r = reconcile(input({ open, close: { ...close, chips: 21 } }));
    expect(r.lines.find((l) => l.sku === "chips")).toMatchObject({ sold: -1, recount: true, cashUnits: null });
  });

  it("has nothing to price before both counts exist", () => {
    const r = reconcile(input({ open, orders }));
    expect(r.counted).toBe(false);
    expect(r.expectedCashSalesCents).toBeNull();
    expect(r.soldUnits).toBeNull();
    expect(r.paypalUnits).toBe(6);
  });
});

describe("cashStatus", () => {
  it("needs two different people to agree", () => {
    expect(cashStatus([]).status).toBe("missing");
    expect(cashStatus([{ countedBy: "A", cents: 5 }]).status).toBe("single");
    expect(cashStatus([{ countedBy: "A", cents: 5 }, { countedBy: " a ", cents: 5 }]).status).toBe("single");
    expect(cashStatus([{ countedBy: "A", cents: 5 }, { countedBy: "B", cents: 6 }]).status).toBe("disagree");
    expect(cashStatus([{ countedBy: "A", cents: 5 }, { countedBy: "B", cents: 6 }, { countedBy: "C", cents: 6 }])).toEqual({ status: "agree", countedCents: 6 });
  });
});

// ---------- properties ----------

const skus = CATALOG.map((c) => c.sku);
const countsArb = (max: number) =>
  fc.tuple(...skus.map(() => fc.integer({ min: 0, max }))).map((vals) => Object.fromEntries(skus.map((s, i) => [s, vals[i]!])) as Counts);
const linesArb = fc
  .subarray(skus, { minLength: 1 })
  .chain((picked) => fc.tuple(...picked.map(() => fc.integer({ min: 1, max: 4 }))).map((qs) => Object.fromEntries(picked.map((s, i) => [s, qs[i]!]))));
const orderArb = fc
  .tuple(fc.constantFrom("COMPLETED", "COMPLETED", "COMPLETED", "REFUNDED", "DECLINED", "CREATED"), linesArb)
  .map(([status, lines]) => order(status, lines));

const scenario = fc.record({
  open: countsArb(60),
  close: countsArb(60),
  waste: countsArb(3),
  orders: fc.array(orderArb, { maxLength: 25 }),
  floatCents: fc.integer({ min: 0, max: 50_000 }),
});

describe("reconcile properties", () => {
  it("adds up exactly in integer cents", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = reconcile(input(s));
        if (r.expectedCashSalesCents === null) return r.recountSkus.length > 0;
        const lineSum = r.lines.reduce((acc, l) => acc + (l.cashUnits ?? 0) * l.priceCents, 0);
        const soldValue = r.lines.reduce((acc, l) => acc + (l.sold ?? 0) * l.priceCents, 0);
        return (
          Number.isInteger(r.expectedCashSalesCents) &&
          r.expectedCashSalesCents === lineSum &&
          r.expectedBoxCents === r.expectedCashSalesCents + s.floatCents &&
          // Every unit sold was paid for exactly once, by PayPal or in cash.
          r.totalSalesCents === soldValue
        );
      }),
    );
  });

  it("never expects negative cash", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = reconcile(input(s));
        const linesOk = r.lines.every((l) => l.cashUnits === null || l.cashUnits >= 0);
        return linesOk && (r.expectedCashSalesCents === null || (r.expectedCashSalesCents >= 0 && r.expectedBoxCents! >= s.floatCents));
      }),
    );
  });

  it("flags any item where PayPal units exceed units sold, and leaves it out of the cash total", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = reconcile(input(s));
        return r.lines.every((l) => {
          if (l.sold === null || l.paypalUnits <= l.sold) return true;
          return l.recount && l.cashUnits === null && l.cashCents === null && r.recountSkus.includes(l.sku) && r.expectedCashSalesCents === null;
        });
      }),
    );
  });

  it("ignores refunded, declined and unpaid orders", () => {
    fc.assert(
      fc.property(scenario, fc.array(orderArb, { maxLength: 10 }), (s, extra) => {
        const notPaid = extra.filter((o) => o.status !== "COMPLETED");
        const base = reconcile(input(s));
        const withExtra = reconcile(input({ ...s, orders: [...s.orders, ...notPaid] }));
        return (
          JSON.stringify(withExtra.lines) === JSON.stringify(base.lines) &&
          withExtra.paypalCents === base.paypalCents &&
          withExtra.paypalUnits === base.paypalUnits &&
          withExtra.expectedBoxCents === base.expectedBoxCents
        );
      }),
    );
  });

  it("refunding a paid order moves its units out of the PayPal column", () => {
    fc.assert(
      fc.property(scenario, fc.nat(), (s, pick) => {
        const paidIdx = s.orders.map((o, i) => (o.status === "COMPLETED" ? i : -1)).filter((i) => i >= 0);
        if (!paidIdx.length) return true;
        const idx = paidIdx[pick % paidIdx.length]!;
        const refunded = s.orders.map((o, i) => (i === idx ? { ...o, status: "REFUNDED" } : o));
        const before = reconcile(input(s));
        const after = reconcile(input({ ...s, orders: refunded }));
        const units = s.orders[idx]!.items.reduce((acc, l) => acc + l.quantity, 0);
        return after.paypalUnits === before.paypalUnits - units && after.paypalCents === before.paypalCents - s.orders[idx]!.totalCents;
      }),
    );
  });
});

describe("band", () => {
  it("uses the tolerance and five times the tolerance as edges", () => {
    expect(band(0, 100)).toBe("green");
    expect(band(100, 100)).toBe("green");
    expect(band(-100, 100)).toBe("green");
    expect(band(101, 100)).toBe("amber");
    expect(band(-500, 100)).toBe("amber");
    expect(band(501, 100)).toBe("red");
    expect(band(-2700, 100)).toBe("red");
  });

  it("matches the definition for any variance and tolerance, regardless of sign", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.integer({ min: 0, max: 10_000 }), (v, t) => {
        const b = band(v, t);
        const a = Math.abs(v);
        const expected = a <= t ? "green" : a <= 5 * t ? "amber" : "red";
        return b === expected && band(-v, t) === b;
      }),
    );
  });
});
