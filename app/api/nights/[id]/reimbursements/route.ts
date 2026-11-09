import { z } from "zod";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { audit, createReimbursement, getNight, getPhoto } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  requester: z.string().trim().min(1, "Enter who bought the supplies.").max(80),
  payeeEmail: z.string().trim().max(254).pipe(z.email("Enter a valid email address.")),
  cents: z.number().int().min(1, "Enter an amount above $0.00.").max(50_000, "Reimbursements above $500.00 go through the treasurer directly."),
  memo: z.string().trim().min(1, "Say what was bought.").max(200),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/, "expected a 64-character photo id").nullish(),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  if (!getNight(id)) throw new HttpError(404, "That game was not found.");
  if (body.receiptSha256 && !getPhoto(body.receiptSha256)) throw new HttpError(400, "Upload the receipt photo first.");

  const rid = createReimbursement({
    nightId: id,
    requester: body.requester,
    payeeEmail: body.payeeEmail,
    cents: body.cents,
    memo: body.memo,
    receiptSha256: body.receiptSha256 ?? null,
  });
  audit(id, body.requester, "reimbursement.requested", { id: rid, cents: body.cents, payeeEmail: body.payeeEmail });
  publish(id, { type: "reimbursement.updated", id: rid });
  return ok({ id: rid }, 201);
});
