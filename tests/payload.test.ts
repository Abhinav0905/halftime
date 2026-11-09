import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { valueToCents } from "../lib/money";
import { buildOrderRequest, CartSchema, cartLines, linesFromPayPalItems, MAX_UNITS_PER_LINE } from "../lib/paypal/payload";
import type { Item } from "../lib/repo";
import { ITEMS } from "../lib/seed";

const CATALOG: Item[] = ITEMS.map((i) => ({ ...i }));
const CTX = { nightId: "night_test", booth: "window", code: "K7A", clubName: "Lincoln High Band Boosters", nightTitle: "vs. Northridge" };

function unitOf(body: ReturnType<typeof buildOrderRequest>["body"]) {
  const unit = body.purchaseUnits[0];
  if (!unit) throw new Error("no purchase unit");
  return unit;
}

describe("buildOrderRequest", () => {
  it("prices the cart from the server catalog", () => {
    const cheaper = CATALOG.map((i) => (i.sku === "hotdog" ? { ...i, priceCents: 250 } : i));
    const built = buildOrderRequest({ hotdog: 2, water: 1 }, cheaper, CTX);
    expect(built.totalCents).toBe(2 * 250 + 100);
    const hotdog = unitOf(built.body).items?.find((i) => i.sku === "hotdog");
    expect(hotdog?.unitAmount.value).toBe("2.50");
  });

  it("rejects an unknown SKU", () => {
    expect(() => buildOrderRequest({ water: 1, lobster: 1 }, CATALOG, CTX)).toThrow("Unknown item: lobster");
  });

  it("rejects an empty cart", () => {
    expect(CartSchema.safeParse({}).success).toBe(false);
    expect(CartSchema.safeParse({ water: 0, chips: 0 }).success).toBe(false);
    expect(() => cartLines({ water: 0 }, CATALOG)).toThrow("The cart is empty.");
  });

  it("only accepts whole quantities within the per-line limit", () => {
    expect(CartSchema.safeParse({ water: 1.5 }).success).toBe(false);
    expect(CartSchema.safeParse({ water: -1 }).success).toBe(false);
    expect(CartSchema.safeParse({ water: MAX_UNITS_PER_LINE + 1 }).success).toBe(false);
    // A price smuggled into the cart is not a quantity, so the cart is refused.
    expect(CartSchema.safeParse({ water: { quantity: 1, price: 0 } }).success).toBe(false);
  });

  it("ties the order to the night and booth", () => {
    const unit = unitOf(buildOrderRequest({ water: 1 }, CATALOG, CTX).body);
    expect(unit.referenceId).toBe("night_test");
    expect(unit.customId).toBe("night_test:window");
    expect(unit.invoiceId).toBe("night_test-K7A");
  });

  it("keeps item_total equal to the amount, with quantities as strings, for any cart", () => {
    const cartArb = fc
      .record(Object.fromEntries(CATALOG.map((i) => [i.sku, fc.integer({ min: 0, max: MAX_UNITS_PER_LINE })])))
      .filter((c) => Object.values(c).some((q) => q > 0));
    fc.assert(
      fc.property(cartArb, (cart) => {
        const built = buildOrderRequest(cart, CATALOG, CTX);
        const unit = unitOf(built.body);
        const items = unit.items ?? [];
        const lineSum = items.reduce((s, i) => s + Number(i.quantity) * valueToCents(i.unitAmount.value), 0);
        return (
          unit.amount.value === unit.amount.breakdown?.itemTotal?.value &&
          valueToCents(unit.amount.value) === built.totalCents &&
          lineSum === built.totalCents &&
          items.every((i) => typeof i.quantity === "string" && /^[1-9]\d*$/.test(i.quantity)) &&
          items.length === Object.values(cart).filter((q) => q > 0).length
        );
      }),
    );
  });

  it("produces the same request for the same cart in any key order", () => {
    const a = buildOrderRequest({ water: 1, hotdog: 2, chips: 1 }, CATALOG, CTX);
    const b = buildOrderRequest({ chips: 1, hotdog: 2, water: 1 }, CATALOG, CTX);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });
});

describe("linesFromPayPalItems", () => {
  it("reads PayPal's recorded lines back into cents and catalog names", () => {
    const lines = linesFromPayPalItems(
      [
        { sku: "hotdog", name: "Hot dog", quantity: "2", unitAmount: { value: "3.00" } },
        { sku: "water", name: "WATER (renamed in PayPal)", quantity: "1", unitAmount: { value: "1.00" } },
      ],
      CATALOG,
    );
    expect(lines).toEqual([
      { sku: "hotdog", name: "Hot dog", quantity: 2, unitCents: 300 },
      { sku: "water", name: "Water", quantity: 1, unitCents: 100 },
    ]);
    expect(linesFromPayPalItems(undefined, CATALOG)).toEqual([]);
  });
});
