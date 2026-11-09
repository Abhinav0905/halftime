import { z } from "zod";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { cashVarianceNotice, recountNoteNotice } from "@/lib/notice-text";
import { addNotice, audit, getCounts, getNight, reconcileNight, setNightStatus, tx } from "@/lib/repo";
import { requireRosterName } from "@/lib/roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  by: z.string().trim().max(80),
  note: z.string().trim().max(1000).optional(),
});

const CASH_NOT_READY = {
  missing: "Two volunteers need to count the cash box first.",
  single: "A second volunteer needs to count the cash box.",
  disagree: "The cash counts are different. Someone other than the last counter counts the box again.",
} as const;

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  if (!getNight(id)) throw new HttpError(404, "That game was not found.");
  const by = requireRosterName(body.by, "Whoever is closing the night");
  const note = body.note || null;

  // Read and write in one transaction so a cash count or refund arriving at the
  // same moment can't change the numbers between the check and the notice.
  tx(() => {
    const night = getNight(id);
    if (!night) throw new HttpError(404, "That game was not found.");
    if (night.status === "closed" || night.status === "deposited") throw new HttpError(409, "This night is already closed.");
    if (night.status !== "closing" || !getCounts(id).close) {
      throw new HttpError(409, "Save the closing count before closing the night.");
    }

    const recon = reconcileNight(night);
    if (recon.cash.status !== "agree") throw new HttpError(409, CASH_NOT_READY[recon.cash.status]);

    // The closing count is locked once the cash is counted, so a note is the way to explain items that don't add up.
    const needsNote = recon.recountSkus.length > 0;
    if (needsNote && (!note || note.length < 10)) {
      throw new HttpError(400, "Some items still need a recount. Add a note (at least 10 characters) about them for the officers.");
    }

    setNightStatus(id, "closed", note);
    if (needsNote && note) addNotice({ nightId: id, ...recountNoteNotice(night, recon, by, note) });
    const cash = cashVarianceNotice(night, recon, by);
    if (cash) addNotice({ nightId: id, ...cash });
    audit(id, by, "night.closed", {
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
