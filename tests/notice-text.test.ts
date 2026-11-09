import { describe, expect, it } from "vitest";
import { reconcile, type CatalogLine, type ReconcileInput } from "../lib/engine/reconcile";
import { cashVarianceNotice, depositVarianceNotice, lateRefundNotice } from "../lib/notice-text";
import type { Night, OrderRow } from "../lib/repo";

const CATALOG: CatalogLine[] = [
  { sku: "water", name: "Water", priceCents: 100 },
  { sku: "hotdog", name: "Hot dog", priceCents: 300 },
];

const NIGHT: Night = {
  id: "n1", title: "vs. Eastside", date: "2026-11-14", floatCents: 10_000, status: "closed", sample: false,
  closeNote: null, createdAt: "2026-11-14T22:00:00Z", closedAt: "2026-11-15T03:00:00Z", depositedAt: null,
};

const ORDER: OrderRow = {
  id: "5O190127TN364715T", nightId: "n1", booth: "window", code: "K7A", status: "COMPLETED",
  items: [{ sku: "hotdog", name: "Hot dog", quantity: 2, unitCents: 300 }], totalCents: 600,
  captureId: "3C679366HH908993F", payer: null, funding: "paypal", simulated: false, declineReason: null, refundId: null,
  createdAt: "2026-11-14T23:00:00Z", capturedAt: "2026-11-14T23:00:05Z", refundedAt: null,
};

const counted = (cents: number) => [{ countedBy: "Jordan Lee", cents }, { countedBy: "Priya Shah", cents }];

function recon(over: Partial<ReconcileInput>) {
  return reconcile({
    items: CATALOG, open: { water: 20, hotdog: 10 }, close: { water: 10, hotdog: 4 }, waste: null,
    orders: [], floatCents: 10_000, cashCounts: [], depositCents: null, toleranceCents: 100, ...over,
  });
}

const paid = { status: "COMPLETED", items: [{ sku: "hotdog", quantity: 2 }], totalCents: 600 };
const refunded = { ...paid, status: "REFUNDED" };

describe("cashVarianceNotice", () => {
  it("names the two people whose totals matched", () => {
    const cashCounts = [
      { countedBy: "Jordan Lee", cents: 11_000 },
      { countedBy: "Priya Shah", cents: 10_500 },
      { countedBy: "Marcus Hill", cents: 11_000 },
    ];
    // 10 water + 6 hot dogs in cash = $28.00, plus the float.
    const draft = cashVarianceNotice(NIGHT, recon({ cashCounts }), "Pat Okafor");
    expect(draft?.body).toContain("Two volunteers (Jordan Lee and Marcus Hill) counted $110.00");
  });
});

describe("depositVarianceNotice", () => {
  it("uses the usual wording when the box held more than the float", () => {
    const draft = depositVarianceNotice(NIGHT, recon({ cashCounts: counted(12_800), depositCents: 2500 }), "Dana Reyes");
    expect(draft).toMatchObject({ level: "amber", title: "Deposit is $3.00 lower than the counted cash" });
    expect(draft?.body).toContain("the deposit should be $28.00");
  });

  it("never asks for a negative deposit", () => {
    const draft = depositVarianceNotice(NIGHT, recon({ cashCounts: counted(5000), depositCents: 5000 }), "Dana Reyes");
    expect(draft?.title).toBe("Deposit of $50.00 recorded when no deposit was expected");
    expect(draft?.body).toContain("counted $50.00 in the box, which is less than the $100.00 float");
    expect(draft?.body).not.toMatch(/should be|−|-\$/);
  });
});

describe("lateRefundNotice", () => {
  it("states the actual change in expected cash, at menu prices", () => {
    const before = recon({ orders: [paid], cashCounts: counted(12_200) });
    const after = recon({ orders: [refunded], cashCounts: counted(12_200) });
    // PayPal's total differs from the menu price; the change follows the menu (2 × $3.00).
    const draft = lateRefundNotice(NIGHT, { ...ORDER, totalCents: 650 }, { before, after });
    expect(draft.body).toContain("Order K7A ($6.50)");
    expect(draft.body).toContain("went from $122.00 to $128.00, up $6.00");
    expect(draft.body).toContain("The $122.00 counted in the box is now $6.00 short of that.");
    expect(draft.level).toBe("red");
  });

  it("says when the refund makes the expected cash possible to work out", () => {
    // PayPal recorded 8 hot dogs but the counts show 6 sold: a recount, until this order is refunded.
    const bigOrder = { status: "COMPLETED", items: [{ sku: "hotdog", quantity: 2 }], totalCents: 600 };
    const rest = { status: "COMPLETED", items: [{ sku: "hotdog", quantity: 6 }], totalCents: 1800 };
    const before = recon({ orders: [rest, bigOrder], cashCounts: counted(11_000) });
    const after = recon({ orders: [rest, { ...bigOrder, status: "REFUNDED" }], cashCounts: counted(11_000) });
    expect(before.expectedBoxCents).toBeNull();
    const draft = lateRefundNotice(NIGHT, ORDER, { before, after });
    expect(draft.body).toContain("couldn't be worked out");
    expect(draft.body).toContain("$110.00 should have been in the box, including the $100.00 float.");
    expect(draft.body).toContain("now matches exactly");
    expect(draft.body).not.toContain("went up");
  });

  it("does not claim a change when the expected cash still can't be worked out", () => {
    const before = recon({ close: { water: 21, hotdog: 4 }, orders: [paid] });
    const after = recon({ close: { water: 21, hotdog: 4 }, orders: [refunded] });
    const draft = lateRefundNotice(NIGHT, ORDER, { before, after });
    expect(draft.body).toContain("still can't be worked out");
    expect(draft.body).not.toMatch(/went (up|from)/);
    expect(draft.level).toBe("amber");
  });

  it("stays accurate without the before and after numbers", () => {
    const draft = lateRefundNotice(NIGHT, ORDER);
    expect(draft.title).toBe("PayPal order K7A was refunded after close-out");
    expect(draft.body).not.toMatch(/went (up|from)/);
  });
});
