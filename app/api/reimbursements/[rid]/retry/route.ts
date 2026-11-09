import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { retryPayout } from "@/lib/paypal/reimbursements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  approver: z.string().trim().max(80),
  // Lets a mistyped address be fixed before the next try.
  payeeEmail: z.string().trim().max(254).pipe(z.email("Enter a valid email address.")).optional(),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ rid: string }> }) => {
  const { rid } = await ctx.params;
  const body = await readJson(req, Body);
  const { reimbursement: r, outcome } = await retryPayout(rid, body.approver, body.payeeEmail);
  if (outcome.kind === "rejected") throw new HttpError(502, `PayPal did not accept the payout: ${outcome.error.message}`);
  const state = { status: r.status, payoutStatus: r.payoutStatus, batchId: r.batchId, error: r.error };
  return ok(state, outcome.kind === "unknown" || outcome.kind === "duplicate" ? 202 : 200);
});
