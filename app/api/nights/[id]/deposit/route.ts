import { z } from "zod";
import { checkDepositor } from "@/lib/engine/rules";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { depositVarianceNotice } from "@/lib/notice-text";
import { addNotice, audit, getNight, getPhoto, listCashCounts, reconcileNight, saveDeposit, setNightStatus, tx } from "@/lib/repo";
import { requireRosterName } from "@/lib/roster";
import { SHA256_RE } from "@/lib/sha256";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  depositor: z.string().trim().max(80),
  cents: z.number().int().min(0).max(10_000_000),
  slipSha256: z.string().regex(SHA256_RE, "expected a 64-character photo id").nullish(),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  if (!getNight(id)) throw new HttpError(404, "That game was not found.");
  const depositor = requireRosterName(body.depositor, "Whoever made the deposit");
  if (body.slipSha256 && !getPhoto(body.slipSha256)) throw new HttpError(400, "Upload the deposit slip photo first.");

  // Status check and write together, so a double-tapped submit records one deposit and one notice.
  const recon = tx(() => {
    const night = getNight(id);
    if (!night) throw new HttpError(404, "That game was not found.");
    if (night.status === "deposited") throw new HttpError(409, "The deposit for this night is already recorded.");
    if (night.status !== "closed") throw new HttpError(409, "Close the night before recording the deposit.");
    const problem = checkDepositor(depositor, listCashCounts(id).map((c) => c.countedBy));
    if (problem) throw new HttpError(400, problem);

    saveDeposit({ nightId: id, depositor, cents: body.cents, slipSha256: body.slipSha256 ?? null });
    setNightStatus(id, "deposited");
    const r = reconcileNight(night);
    const notice = depositVarianceNotice(night, r, depositor);
    if (notice) addNotice({ nightId: id, ...notice });
    audit(id, depositor, "deposit.recorded", {
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
