import { HttpError, handle, ok } from "@/lib/http";
import { getNightState } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const state = getNightState(id);
  if (!state) throw new HttpError(404, "That game was not found.");
  return ok(state);
});
