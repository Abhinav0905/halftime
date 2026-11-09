import { HttpError, handle, ok } from "@/lib/http";
import { audit, listNotices, markNoticeRead } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const notice = listNotices().find((n) => n.id === id);
  if (!notice) throw new HttpError(404, "That notice was not found.");
  if (!notice.readAt) {
    markNoticeRead(id);
    audit(notice.nightId, null, "notice.read", { id, title: notice.title });
  }
  return ok({ ok: true });
});
