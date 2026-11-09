import { HttpError, handle, ok } from "@/lib/http";
import { audit } from "@/lib/repo";
import { seedDemo } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async () => {
  if (process.env.DEMO_RESET_ENABLED === "false") throw new HttpError(403, "Resetting the sample data is turned off on this server.");
  seedDemo(true);
  audit(null, null, "demo.reset");
  return ok({ ok: true });
});
