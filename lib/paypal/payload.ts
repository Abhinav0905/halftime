// Builds the Orders v2 request from a buyer's cart. Prices always come from the
// club's catalog on the server; the browser only sends SKUs and quantities.

import { z } from "zod";
import {
  CheckoutPaymentIntent, ItemCategory, type OrderRequest,
} from "@paypal/paypal-server-sdk";
import { centsToValue, valueToCents } from "../money";
import type { Item, OrderItem } from "../repo";

export const MAX_UNITS_PER_LINE = 20;

export const CartSchema = z
  .record(z.string().min(1).max(32), z.number().int().min(0).max(MAX_UNITS_PER_LINE))
  .refine((cart) => Object.values(cart).some((q) => q > 0), { message: "The cart is empty." });

export type Cart = z.infer<typeof CartSchema>;

export interface BuiltOrder {
  lines: OrderItem[];
  totalCents: number;
  body: OrderRequest;
}

export function cartLines(cart: Cart, catalog: Item[]): OrderItem[] {
  const bySku = new Map(catalog.map((i) => [i.sku, i]));
  const lines: OrderItem[] = [];
  for (const [sku, quantity] of Object.entries(cart)) {
    if (quantity === 0) continue;
    const item = bySku.get(sku);
    if (!item) throw new Error(`Unknown item: ${sku}`);
    lines.push({ sku, name: item.name, quantity, unitCents: item.priceCents });
  }
  if (!lines.length) throw new Error("The cart is empty.");
  // Stable order (catalog order) so identical carts produce identical requests.
  const pos = new Map(catalog.map((i, idx) => [i.sku, idx]));
  return lines.sort((a, b) => (pos.get(a.sku) ?? 0) - (pos.get(b.sku) ?? 0));
}

export function buildOrderRequest(
  cart: Cart,
  catalog: Item[],
  ctx: { nightId: string; booth: string; code: string; clubName: string; nightTitle: string },
): BuiltOrder {
  const lines = cartLines(cart, catalog);
  const totalCents = lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
  const body: OrderRequest = {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
        referenceId: ctx.nightId,
        // custom_id ties every capture back to the game and booth during reconciliation.
        customId: `${ctx.nightId}:${ctx.booth}`,
        invoiceId: `${ctx.nightId}-${ctx.code}`,
        description: `${ctx.clubName} concessions, ${ctx.nightTitle}`.slice(0, 127),
        softDescriptor: "BOOSTERS",
        amount: {
          currencyCode: "USD",
          value: centsToValue(totalCents),
          breakdown: { itemTotal: { currencyCode: "USD", value: centsToValue(totalCents) } },
        },
        items: lines.map((l) => ({
          name: l.name,
          sku: l.sku,
          quantity: String(l.quantity),
          unitAmount: { currencyCode: "USD", value: centsToValue(l.unitCents) },
          category: ItemCategory.PhysicalGoods,
        })),
      },
    ],
  };
  return { lines, totalCents, body };
}

/** Item lines as PayPal recorded them (from GET /v2/checkout/orders/{id}). */
export function linesFromPayPalItems(
  items: { sku?: string; name: string; quantity: string; unitAmount: { value: string } }[] | undefined,
  catalog: Item[],
): OrderItem[] {
  if (!items) return [];
  const names = new Map(catalog.map((i) => [i.sku, i.name]));
  return items.map((i) => {
    const sku = i.sku ?? "";
    return { sku, name: names.get(sku) ?? i.name, quantity: Number(i.quantity), unitCents: valueToCents(i.unitAmount.value) };
  });
}
