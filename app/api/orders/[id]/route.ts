import { HttpError, handle, ok } from "@/lib/http";
import { getOrder } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Order status for the buyer's phone, which polls it while PayPal confirms a payment.
 * Public, so it leaves out the payer, the capture id and anything about the night.
 */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const row = getOrder(id);
  if (!row) throw new HttpError(404, "That order was not found.");
  return ok({ status: row.status, code: row.code, items: row.items, totalCents: row.totalCents });
});
