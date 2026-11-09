import { z } from "zod";
import { cashStatus } from "@/lib/engine/reconcile";
import { checkCashCounter, checkCashCounterNotCloser } from "@/lib/engine/rules";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { addCashCount, audit, getCounts, getNight, listCashCounts, reconcileNight, tx } from "@/lib/repo";
import { requireRosterName } from "@/lib/roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  countedBy: z.string().trim().max(80),
  cents: z.number().int().min(0).max(10_000_000),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  if (!getNight(id)) throw new HttpError(404, "That game was not found.");
  const countedBy = requireRosterName(body.countedBy, "Whoever counted the cash");

  // Checks and the insert share one transaction so two phones submitting at once
  // cannot both pass the "different volunteer" and "already agreed" checks.
  const night = tx(() => {
    const current = getNight(id);
    if (!current) throw new HttpError(404, "That game was not found.");
    if (current.status === "setup" || current.status === "selling") {
      throw new HttpError(409, "Save the closing count before counting the cash box.");
    }
    if (current.status !== "closing") throw new HttpError(409, "This night is already closed.");

    const previous = listCashCounts(id);
    // Once two counts match, the expected amount is on screen. A later count could
    // quietly replace a shortfall, so the count is done at that point.
    if (cashStatus(previous).status === "agree") {
      throw new HttpError(409, "Two cash counts already match, so the cash count is done. Finalize the night, and add a note if something looks off.");
    }
    const problem = checkCashCounterNotCloser(countedBy, getCounts(id).close) ?? checkCashCounter(countedBy, previous);
    if (problem) throw new HttpError(400, problem);

    addCashCount(id, countedBy, body.cents);
    // The amount stays out of the audit log: the counts are blind, and the log is visible on the night page.
    audit(id, countedBy, "cash.counted", { count: previous.length + 1 });
    return current;
  });
  publish(id, { type: "cash.counted" });

  const { cash } = reconcileNight(night);
  return ok({ ok: true, cash: { status: cash.status, countedCents: cash.countedCents } });
});
