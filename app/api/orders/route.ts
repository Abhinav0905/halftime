import crypto from "node:crypto";
import { z } from "zod";
import { paypalConfigured } from "@/lib/config";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { newId, pickupCode } from "@/lib/ids";
import { PayPalError } from "@/lib/paypal/client";
import { createOrder } from "@/lib/paypal/orders";
import { buildOrderRequest, CartSchema, type BuiltOrder } from "@/lib/paypal/payload";
import { audit, codeTaken, getClub, getNight, getOrder, insertOrder, listItems, type OrderRow } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  nightId: z.string().min(1).max(64),
  booth: z.string().trim().regex(/^[a-z0-9-]{1,24}$/, "booth: use lowercase letters, digits and dashes").default("window"),
  cart: CartSchema,
  // Sent by the menu once per cart submission, so a double-tapped Pay reuses the same PayPal order.
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "requestId: 8 to 64 letters, digits, - or _").optional(),
});

function freeCode(nightId: string): string {
  for (let i = 0; i < 50; i++) {
    const code = pickupCode();
    if (!codeTaken(nightId, code)) return code;
  }
  throw new HttpError(503, "Could not find a free pickup code. Please try again.");
}

function existing(o: OrderRow): Response {
  return ok({ id: o.id, code: o.code, totalCents: o.totalCents, simulated: o.simulated });
}

export const POST = handle(async (req: Request) => {
  const body = await readJson(req, Body);
  const night = getNight(body.nightId);
  if (!night) throw new HttpError(404, "That game was not found.");
  if (night.status !== "selling") throw new HttpError(409, "The stand is not taking orders right now.");

  const code = freeCode(night.id);
  let built: BuiltOrder;
  try {
    built = buildOrderRequest(body.cart, listItems(), {
      nightId: night.id,
      booth: body.booth,
      code,
      clubName: getClub().name,
      nightTitle: night.title,
    });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "That cart could not be priced.");
  }

  const requestId = body.requestId ?? newId("req");
  const simulated = !paypalConfigured();
  let id: string;
  if (simulated) {
    id = `SIM-${crypto.createHash("sha256").update(requestId).digest("base64url").slice(0, 16)}`;
  } else {
    try {
      ({ id } = await createOrder(built, `order-${requestId}`));
    } catch (err) {
      if (err instanceof PayPalError) throw new HttpError(502, `PayPal could not start the payment: ${err.message}`);
      throw err;
    }
  }

  // A repeated requestId gets PayPal's original order back; answer with the row we already stored.
  const prior = getOrder(id);
  if (prior) return existing(prior);
  try {
    insertOrder({ id, nightId: night.id, booth: body.booth, code, items: built.lines, totalCents: built.totalCents, simulated });
  } catch (err) {
    const raced = getOrder(id);
    if (raced) return existing(raced);
    throw err;
  }
  audit(night.id, null, "order.created", { orderId: id, code, booth: body.booth, totalCents: built.totalCents, simulated });
  return ok({ id, code, totalCents: built.totalCents, simulated }, 201);
});
