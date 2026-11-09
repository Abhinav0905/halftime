// The close-out math. Pure functions, integer cents, no I/O.
//
// For each item:   sold      = opening count − closing count − waste
//                  paypal    = units in COMPLETED PayPal orders (refunds excluded)
//                  cash      = sold − paypal
// Expected cash in the box  = Σ cash × price + opening float
//
// PayPal's itemized orders are exact, so they are a floor on units sold. If
// PayPal says more units were sold than the photos do, a count is wrong and
// the item is flagged for a recount instead of producing a negative cash line.

export type Counts = Record<string, number>;

export interface CatalogLine {
  sku: string;
  name: string;
  priceCents: number;
}

export interface OrderLine {
  sku: string;
  quantity: number;
}

export interface OrderForRecon {
  status: string; // only "COMPLETED" counts
  items: OrderLine[];
  totalCents: number;
}

export interface CashCount {
  countedBy: string;
  cents: number;
}

export type Band = "green" | "amber" | "red";

export interface ReconcileInput {
  items: CatalogLine[];
  open: Counts | null;
  close: Counts | null;
  waste?: Counts | null;
  orders: OrderForRecon[];
  floatCents: number;
  cashCounts: CashCount[];
  depositCents: number | null;
  /** Variance within this is green; within 5× is amber; beyond is red. */
  toleranceCents: number;
}

export interface ItemResult {
  sku: string;
  name: string;
  priceCents: number;
  open: number | null;
  close: number | null;
  waste: number;
  sold: number | null;
  paypalUnits: number;
  cashUnits: number | null;
  cashCents: number | null;
  recount: boolean;
  recountReason: string | null;
}

export type CashStatus = "missing" | "single" | "agree" | "disagree";

export interface ReconcileResult {
  /** Opening and closing counts both exist. */
  counted: boolean;
  lines: ItemResult[];
  recountSkus: string[];
  paypalCents: number;
  paypalOrders: number;
  refundedOrders: number;
  paypalUnits: number;
  soldUnits: number | null;
  cashUnits: number | null;
  expectedCashSalesCents: number | null;
  expectedBoxCents: number | null;
  totalSalesCents: number | null;
  cash: { status: CashStatus; countedCents: number | null; counts: CashCount[] };
  cashVarianceCents: number | null;
  cashBand: Band | null;
  depositExpectedCents: number | null;
  depositCents: number | null;
  depositVarianceCents: number | null;
  depositBand: Band | null;
}

export function band(varianceCents: number, toleranceCents: number): Band {
  const v = Math.abs(varianceCents);
  if (v <= toleranceCents) return "green";
  if (v <= toleranceCents * 5) return "amber";
  return "red";
}

export function paypalUnitsBySku(orders: OrderForRecon[]): Counts {
  const units: Counts = {};
  for (const o of orders) {
    if (o.status !== "COMPLETED") continue;
    for (const line of o.items) {
      units[line.sku] = (units[line.sku] ?? 0) + line.quantity;
    }
  }
  return units;
}

export function cashStatus(counts: CashCount[]): { status: CashStatus; countedCents: number | null } {
  if (counts.length === 0) return { status: "missing", countedCents: null };
  if (counts.length === 1) return { status: "single", countedCents: null };
  // The two most recent counts by different people decide it.
  const last = counts[counts.length - 1]!;
  const prev = [...counts].reverse().find((c) => samePerson(c.countedBy, last.countedBy) === false);
  if (!prev) return { status: "single", countedCents: null };
  return last.cents === prev.cents
    ? { status: "agree", countedCents: last.cents }
    : { status: "disagree", countedCents: null };
}

export function samePerson(a: string, b: string): boolean {
  const norm = (x: string) => x.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { items, open, close, orders, floatCents, cashCounts, depositCents, toleranceCents } = input;
  const waste = input.waste ?? {};
  const paypal = paypalUnitsBySku(orders);
  const counted = open !== null && close !== null;

  const lines: ItemResult[] = items.map((item) => {
    const o = open ? open[item.sku] ?? 0 : null;
    const c = close ? close[item.sku] ?? 0 : null;
    const w = waste[item.sku] ?? 0;
    const p = paypal[item.sku] ?? 0;
    let sold: number | null = null;
    let cashUnits: number | null = null;
    let recount = false;
    let recountReason: string | null = null;

    if (o !== null && c !== null) {
      sold = o - c - w;
      if (sold < 0) {
        recount = true;
        recountReason = `Closing count (${c}) plus waste (${w}) is more than the opening count (${o}).`;
      } else if (p > sold) {
        recount = true;
        recountReason = `PayPal recorded ${p} sold, but the counts show only ${sold}.`;
      }
      cashUnits = recount ? null : sold - p;
    }

    return {
      sku: item.sku,
      name: item.name,
      priceCents: item.priceCents,
      open: o,
      close: c,
      waste: w,
      sold,
      paypalUnits: p,
      cashUnits,
      cashCents: cashUnits === null ? null : cashUnits * item.priceCents,
      recount,
      recountReason,
    };
  });

  const recountSkus = lines.filter((l) => l.recount).map((l) => l.sku);
  const completed = orders.filter((o) => o.status === "COMPLETED");
  const paypalCents = completed.reduce((s, o) => s + o.totalCents, 0);
  const paypalUnits = Object.values(paypal).reduce((s, n) => s + n, 0);

  const canPrice = counted && recountSkus.length === 0;
  const expectedCashSalesCents = canPrice ? lines.reduce((s, l) => s + (l.cashCents ?? 0), 0) : null;
  const expectedBoxCents = expectedCashSalesCents === null ? null : expectedCashSalesCents + floatCents;

  const cs = cashStatus(cashCounts);
  const cashVarianceCents =
    expectedBoxCents !== null && cs.countedCents !== null ? cs.countedCents - expectedBoxCents : null;
  const depositExpectedCents = cs.countedCents !== null ? cs.countedCents - floatCents : null;
  const depositVarianceCents =
    depositExpectedCents !== null && depositCents !== null ? depositCents - depositExpectedCents : null;

  return {
    counted,
    lines,
    recountSkus,
    paypalCents,
    paypalOrders: completed.length,
    refundedOrders: orders.filter((o) => o.status === "REFUNDED").length,
    paypalUnits,
    soldUnits: counted ? lines.reduce((s, l) => s + Math.max(0, l.sold ?? 0), 0) : null,
    cashUnits: canPrice ? lines.reduce((s, l) => s + (l.cashUnits ?? 0), 0) : null,
    expectedCashSalesCents,
    expectedBoxCents,
    totalSalesCents: expectedCashSalesCents === null ? null : expectedCashSalesCents + paypalCents,
    cash: { ...cs, counts: cashCounts },
    cashVarianceCents,
    cashBand: cashVarianceCents === null ? null : band(cashVarianceCents, toleranceCents),
    depositExpectedCents,
    depositCents,
    depositVarianceCents,
    depositBand: depositVarianceCents === null ? null : band(depositVarianceCents, toleranceCents),
  };
}
