import { z } from "zod";
import { checkDepositor } from "@/lib/engine/rules";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { depositVarianceNotice } from "@/lib/notice-text";
import { addNotice, audit, getNight, getPhoto, listCashCounts, reconcileNight, saveDeposit, setNightStatus, tx } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  depositor: z.string().trim().max(80),
  cents: z.number().int().min(0).max(10_000_000),
  slipSha256: z.string().regex(/^[a-f0-9]{64}$/, "expected a 64-character photo id").nullish(),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  const night = getNight(id);
  if (!night) throw new HttpError(404, "That game was not found.");
  if (night.status === "deposited") throw new HttpError(409, "The deposit for this night is already recorded.");
  if (night.status !== "closed") throw new HttpError(409, "Close the night before recording the deposit.");

  const problem = checkDepositor(body.depositor, listCashCounts(id).map((c) => c.countedBy));
  if (problem) throw new HttpError(400, problem);
  if (body.slipSha256 && !getPhoto(body.slipSha256)) throw new HttpError(400, "Upload the deposit slip photo first.");

  const recon = tx(() => {
    saveDeposit({ nightId: id, depositor: body.depositor, cents: body.cents, slipSha256: body.slipSha256 ?? null });
    setNightStatus(id, "deposited");
    const r = reconcileNight(night);
    const notice = depositVarianceNotice(night, r, body.depositor);
    if (notice) addNotice({ nightId: id, ...notice });
    audit(id, body.depositor, "deposit.recorded", {
      cents: body.cents,
      expectedCents: r.depositExpectedCents,
      varianceCents: r.depositVarianceCents,
      band: r.depositBand,
      slipSha256: body.slipSha256 ?? null,
    });
    return r;
  });
  publish(id, { type: "night.status", status: "deposited" });
  return ok({ ok: true, depositVarianceCents: recon.depositVarianceCents, band: recon.depositBand });
});
