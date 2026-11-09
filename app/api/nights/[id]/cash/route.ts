import { z } from "zod";
import { checkCashCounter } from "@/lib/engine/rules";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { addCashCount, audit, getNight, listCashCounts, reconcileNight } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  countedBy: z.string().trim().max(80),
  cents: z.number().int().min(0).max(10_000_000),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await readJson(req, Body);
  const night = getNight(id);
  if (!night) throw new HttpError(404, "That game was not found.");
  if (night.status === "setup" || night.status === "selling") {
    throw new HttpError(409, "Save the closing count before counting the cash box.");
  }
  if (night.status !== "closing") throw new HttpError(409, "This night is already closed.");

  const previous = listCashCounts(id);
  const problem = checkCashCounter(body.countedBy, previous);
  if (problem) throw new HttpError(400, problem);

  addCashCount(id, body.countedBy, body.cents);
  // The amount stays out of the audit log: the counts are blind, and the log is visible on the night page.
  audit(id, body.countedBy, "cash.counted", { count: previous.length + 1 });
  publish(id, { type: "cash.counted" });

  const { cash } = reconcileNight(night);
  return ok({ ok: true, cash: { status: cash.status, countedCents: cash.countedCents } });
});
