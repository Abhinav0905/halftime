import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { audit } from "@/lib/repo";
import { seedDemo } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Confirm = z.object({ confirm: z.literal("reset", { error: 'Send { "confirm": "reset" } to reset the sample data.' }) });

/** Browsers always send Origin on a cross-site POST, so a mismatch means another site is submitting this. */
function fromThisSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Wipes every game, so it takes a JSON body (another site can't send one without a CORS preflight we never answer),
// a same-origin request, and, when STAFF_PIN is set, the staff cookie (proxy.ts).
export const POST = handle(async (req: Request) => {
  if (process.env.DEMO_RESET_ENABLED === "false") throw new HttpError(403, "Resetting the sample data is turned off on this server.");
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Reset the sample data from the Halftime home page.");
  }
  if (!fromThisSite(req)) throw new HttpError(403, "Reset the sample data from the Halftime home page.");
  await readJson(req, Confirm);
  seedDemo(true);
  audit(null, null, "demo.reset");
  return ok({ ok: true });
});
