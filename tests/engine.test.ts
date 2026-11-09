import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  agreeingCounts, band, cashStatus, reconcile, samePerson, type CatalogLine, type Counts, type OrderForRecon, type ReconcileInput,
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
  const c = (countedBy: string, cents: number) => ({ countedBy, cents });

  it("needs two different people to agree", () => {
    expect(cashStatus([]).status).toBe("missing");
    expect(cashStatus([c("A", 5)]).status).toBe("single");
    expect(cashStatus([c("A", 5), c(" a ", 5)]).status).toBe("single");
    expect(cashStatus([c("A", 5), c("B", 6)]).status).toBe("disagree");
    expect(cashStatus([c("A", 5), c("B", 6), c("C", 6)])).toEqual({ status: "agree", countedCents: 6 });
  });

  it("agrees when a third count matches the first, even with a different count in between", () => {
    expect(cashStatus([c("A", 500), c("B", 400), c("C", 500)])).toEqual({ status: "agree", countedCents: 500 });
    expect(agreeingCounts([c("A", 500), c("B", 400), c("C", 500)])).toEqual([c("A", 500), c("C", 500)]);
  });

  it("does not let someone agree with their own earlier count", () => {
    expect(cashStatus([c("A", 100), c("B", 90), c("A", 100)])).toEqual({ status: "disagree", countedCents: null });
    expect(cashStatus([c("A", 100), c("B", 90), c("Ａ", 100)]).status).toBe("disagree"); // full-width letter
  });

  it("agrees when someone's recount matches the other person", () => {
    expect(cashStatus([c("A", 100), c("B", 90), c("A", 90)])).toEqual({ status: "agree", countedCents: 90 });
  });

  it("only the latest count decides; an older matching pair does not count once a later count differs", () => {
    expect(cashStatus([c("A", 100), c("B", 100), c("C", 95)]).status).toBe("disagree");
  });
});

describe("samePerson", () => {
  it("ignores case, spacing and invisible characters", () => {
    expect(samePerson("Marcus Hill", "  marcus   HILL ")).toBe(true);
    expect(samePerson("Marcus Hill", "Marcus\u200b Hill")).toBe(true);
    expect(samePerson("Marcus Hill", "Marcus\u00a0Hill")).toBe(true);
    expect(samePerson("Marcus Hill", "Marcus Hall")).toBe(false);
  });
});

describe("deposit expected", () => {
  it("never expects a negative deposit when the box holds less than the float", () => {
    const counts = [{ countedBy: "A", cents: 5000 }, { countedBy: "B", cents: 5000 }];
    const r = reconcile(input({ floatCents: 10_000, cashCounts: counts, depositCents: 0 }));
    expect(r.depositExpectedCents).toBe(0);
    expect(r.depositVarianceCents).toBe(0);
    expect(r.depositBand).toBe("green");
    const deposited = reconcile(input({ floatCents: 10_000, cashCounts: counts, depositCents: 5000 }));
    expect(deposited.depositVarianceCents).toBe(5000);
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

// Anything goes: counts that may not add up, orders of every status. Reaches the recount branches.
const scenario = fc.record({
  open: countsArb(60),
  close: countsArb(60),
  waste: countsArb(3),
  orders: fc.array(orderArb, { maxLength: 25 }),
  floatCents: fc.integer({ min: 0, max: 50_000 }),
});

interface PricedNight {
  open: Counts;
  close: Counts;
  waste: Counts;
  orders: OrderForRecon[];
  floatCents: number;
  /** What the generator knows each item's cash units must be: sold − PayPal. */
  cashUnits: Counts;
}

// A night whose counts agree with PayPal: for each item, sold ≤ opening, PayPal units ≤ sold,
// waste fits in what was left. The cash total can always be priced, so the arithmetic
// properties below run on every generated case instead of the 1–2% the random scenario prices.
const itemArb = (open: number) =>
  fc.integer({ min: 0, max: open }).chain((sold) =>
    fc.record({
      sold: fc.constant(sold),
      paypal: fc.integer({ min: 0, max: sold }),
      waste: fc.integer({ min: 0, max: Math.min(3, open - sold) }),
      chunk: fc.integer({ min: 1, max: 4 }),
    }),
  );
const notPaidArb = orderArb.filter((o) => o.status !== "COMPLETED");

const pricedNight: fc.Arbitrary<PricedNight> = countsArb(60).chain((open) =>
  fc
    .record({
      perItem: fc.tuple(...skus.map((s) => itemArb(open[s]!))),
      noise: fc.array(notPaidArb, { maxLength: 6 }),
      floatCents: fc.integer({ min: 0, max: 50_000 }),
    })
    .map(({ perItem, noise, floatCents }) => {
      const close: Counts = {};
      const waste: Counts = {};
      const cashUnits: Counts = {};
      // Split each item's PayPal units into chunks; order i carries chunk i of every item that has one.
      const chunks: Record<string, number>[] = [];
      skus.forEach((sku, i) => {
        const { sold, paypal, waste: w, chunk } = perItem[i]!;
        close[sku] = open[sku]! - sold - w;
        waste[sku] = w;
        cashUnits[sku] = sold - paypal;
        for (let left = paypal, k = 0; left > 0; left -= chunk, k++) {
          (chunks[k] ??= {})[sku] = Math.min(chunk, left);
        }
      });
      const paid = chunks.map((lines) => order("COMPLETED", lines));
      return { open, close, waste, orders: [...paid, ...noise], floatCents, cashUnits };
    }),
);

const reconInput = (n: PricedNight) => input({ open: n.open, close: n.close, waste: n.waste, orders: n.orders, floatCents: n.floatCents });

describe("reconcile properties", () => {
  it("adds up exactly in integer cents", () => {
    fc.assert(
      fc.property(pricedNight, (n) => {
        const r = reconcile(reconInput(n));
        expect(r.recountSkus).toEqual([]);
        expect(r.expectedCashSalesCents).not.toBeNull();
        const lineSum = r.lines.reduce((acc, l) => acc + (l.cashUnits ?? 0) * l.priceCents, 0);
        const soldValue = r.lines.reduce((acc, l) => acc + (l.sold ?? 0) * l.priceCents, 0);
        const generated = skus.reduce((acc, sku) => acc + n.cashUnits[sku]! * PRICE.get(sku)!, 0);
        return (
          Number.isInteger(r.expectedCashSalesCents) &&
          r.lines.every((l) => l.cashUnits === n.cashUnits[l.sku]) &&
          r.expectedCashSalesCents === lineSum &&
          r.expectedCashSalesCents === generated &&
          r.expectedBoxCents === r.expectedCashSalesCents + n.floatCents &&
          // Every unit sold was paid for exactly once, by PayPal or in cash.
          r.totalSalesCents === soldValue
        );
      }),
    );
  });

  it("never expects negative cash", () => {
    fc.assert(
      fc.property(pricedNight, (n) => {
        const r = reconcile(reconInput(n));
        return (
          r.expectedCashSalesCents !== null &&
          r.expectedCashSalesCents >= 0 &&
          r.expectedBoxCents! >= n.floatCents &&
          r.lines.every((l) => l.cashUnits !== null && l.cashUnits >= 0)
        );
      }),
    );
    // Messy nights too: a line is either priced at zero or more, or left out for a recount.
    fc.assert(fc.property(scenario, (s) => reconcile(input(s)).lines.every((l) => l.cashUnits === null || l.cashUnits >= 0)));
  });

  it("flags any item where PayPal units exceed units sold, and leaves it out of the cash total", () => {
    // Start from a night that adds up, then raise one closing count past what PayPal allows.
    const overCounted = fc
      .tuple(pricedNight, fc.constantFrom(...skus), fc.integer({ min: 1, max: 3 }))
      .filter(([n, sku]) => n.orders.some((o) => o.status === "COMPLETED" && o.items.some((l) => l.sku === sku)))
      .map(([n, sku, extra]) => ({ ...n, sku, close: { ...n.close, [sku]: n.close[sku]! + n.cashUnits[sku]! + extra } }));
    let flagged = 0;
    fc.assert(
      fc.property(fc.oneof(overCounted, scenario), (s) => {
        const r = reconcile(input(s));
        return r.lines.every((l) => {
          if (l.sold === null || l.sold < 0 || l.paypalUnits <= l.sold) return true;
          flagged++;
          return l.recount && l.cashUnits === null && l.cashCents === null && r.recountSkus.includes(l.sku) && r.expectedCashSalesCents === null;
        });
      }),
      { numRuns: 200 },
    );
    // Guard against a generator change that quietly stops reaching the case under test.
    expect(flagged).toBeGreaterThan(50);
  });

  it("ignores refunded, declined and unpaid orders", () => {
    fc.assert(
      fc.property(fc.oneof(pricedNight, scenario), fc.array(orderArb, { maxLength: 10 }), (s, extra) => {
        const notPaid = extra.filter((o) => o.status !== "COMPLETED");
        const base = reconcile(input({ open: s.open, close: s.close, waste: s.waste, orders: s.orders, floatCents: s.floatCents }));
        const withExtra = reconcile(input({ open: s.open, close: s.close, waste: s.waste, orders: [...s.orders, ...notPaid], floatCents: s.floatCents }));
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

  it("refunding a paid order on a night that adds up raises the expected cash by its items at menu prices", () => {
    fc.assert(
      fc.property(pricedNight, fc.nat(), (n, pick) => {
        const paidIdx = n.orders.map((o, i) => (o.status === "COMPLETED" ? i : -1)).filter((i) => i >= 0);
        fc.pre(paidIdx.length > 0);
        const idx = paidIdx[pick % paidIdx.length]!;
        const before = reconcile(reconInput(n));
        const after = reconcile(reconInput({ ...n, orders: n.orders.map((o, i) => (i === idx ? { ...o, status: "REFUNDED" } : o)) }));
        const value = n.orders[idx]!.items.reduce((acc, l) => acc + l.quantity * PRICE.get(l.sku)!, 0);
        return after.expectedBoxCents !== null && after.expectedBoxCents - before.expectedBoxCents! === value;
      }),
    );
  });
});

describe("cashStatus properties", () => {
  const people = ["Jordan Lee", "Priya Shah", "Marcus Hill"];
  const countsArbitrary = fc.array(fc.record({ countedBy: fc.constantFrom(...people), cents: fc.constantFrom(9000, 10_000) }), { maxLength: 6 });

  it("agrees exactly when the latest count matches an earlier count by someone else", () => {
    fc.assert(
      fc.property(countsArbitrary, (counts) => {
        const last = counts.at(-1);
        const matched = !!last && counts.slice(0, -1).some((c) => c.cents === last.cents && c.countedBy !== last.countedBy);
        const { status, countedCents } = cashStatus(counts);
        if (matched) return status === "agree" && countedCents === last!.cents;
        return status !== "agree" && countedCents === null;
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
