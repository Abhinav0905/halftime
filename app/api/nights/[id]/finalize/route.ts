import { z } from "zod";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { cashVarianceNotice, recountNoteNotice } from "@/lib/notice-text";
import { addNotice, audit, getCounts, getNight, reconcileNight, setNightStatus, tx } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  by: z.string().trim().min(1, "Enter who is closing the night.").max(80),
  note: z.string().trim().max(1000).optional(),
});

const CASH_NOT_READY = {
  missing: "Two volunteers need to count the cash box first.",
  single: "A second volunteer needs to count the cash box.",
  disagree: "The two cash counts do not match. Ask another volunteer to recount the box.",
} as const;

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  const night = getNight(id);
  if (!night) throw new HttpError(404, "That game was not found.");
  if (night.status === "closed" || night.status === "deposited") throw new HttpError(409, "This night is already closed.");
  if (night.status !== "closing" || !getCounts(id).close) {
    throw new HttpError(409, "Save the closing count before closing the night.");
  }

  const recon = reconcileNight(night);
  if (recon.cash.status !== "agree") throw new HttpError(409, CASH_NOT_READY[recon.cash.status]);

  const note = body.note || null;
  const needsNote = recon.recountSkus.length > 0;
  if (needsNote && (!note || note.length < 10)) {
    throw new HttpError(400, "Some items still need a recount. Recount them, or add a note (at least 10 characters) explaining the difference.");
  }

  tx(() => {
    setNightStatus(id, "closed", note);
    if (needsNote && note) addNotice({ nightId: id, ...recountNoteNotice(night, recon, body.by, note) });
    const cash = cashVarianceNotice(night, recon, body.by);
    if (cash) addNotice({ nightId: id, ...cash });
    audit(id, body.by, "night.closed", {
      expectedBoxCents: recon.expectedBoxCents,
      countedCents: recon.cash.countedCents,
      cashVarianceCents: recon.cashVarianceCents,
      cashBand: recon.cashBand,
      recountSkus: recon.recountSkus,
      note,
    });
  });
  publish(id, { type: "night.status", status: "closed" });
  return ok({ ok: true, status: "closed" });
});
