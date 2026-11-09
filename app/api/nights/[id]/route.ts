import { HttpError, handle, ok } from "@/lib/http";
import { redactNightState } from "@/lib/redact";
import { getNightState } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The window board polls this, so it gets the redacted view: no emails, capture ids
// or photo hashes, and nothing that reveals the cash while the count is blind.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const state = getNightState(id);
  if (!state) throw new HttpError(404, "That game was not found.");
  return ok(redactNightState(state));
});
