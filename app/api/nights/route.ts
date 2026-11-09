import { z } from "zod";
import { handle, ok, readJson } from "@/lib/http";
import { audit, createNight } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  title: z.string().trim().min(1, "Enter the game, e.g. vs. Northridge.").max(80),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.")
    .refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)), "That date does not exist."),
  floatCents: z.number().int().min(0).max(100_000, "The float can be at most $1,000.00."),
});

export const POST = handle(async (req: Request) => {
  ensureSeeded();
  const body = await readJson(req, Body);
  const id = createNight(body);
  audit(id, null, "night.created", body);
  return ok({ id }, 201);
});
