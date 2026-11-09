import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { SHA256_RE, readPhoto } from "@/lib/photos";
import { audit, getNight, listItems, saveSuggestion } from "@/lib/repo";
import { suggestCounts } from "@/lib/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(["open", "close"]),
  sha256: z.string().regex(SHA256_RE, "expected a 64-character photo id"),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!getNight(id)) throw new HttpError(404, "That game night was not found.");
  const { kind, sha256 } = await readJson(req, Body);

  const photo = readPhoto(sha256);
  if (!photo) throw new HttpError(404, "That photo was not found. Please take it again.");

  const out = await suggestCounts({ sha256, bytes: photo.bytes, mime: photo.mime, catalog: listItems() });

  if (!out.result) {
    audit(id, null, "suggestion.unavailable", { kind, sha256, provider: out.provider, model: out.model });
    return ok({ suggestionId: null, provider: out.provider, model: out.model, result: null, message: out.message });
  }

  const suggestionId = saveSuggestion({
    nightId: id,
    kind,
    photoSha256: sha256,
    // Keep replayed answers distinguishable from live ones in the stored record.
    model: out.provider === "replay" ? `replay:${out.model ?? "recorded"}` : out.model ?? out.provider,
    result: out.result,
  });
  audit(id, null, "suggestion.created", {
    suggestionId,
    kind,
    sha256,
    provider: out.provider,
    model: out.model,
    latencyMs: out.latencyMs ?? null,
    counts: Object.fromEntries(out.result.items.map((i) => [i.sku, i.count])),
  });

  return ok({
    suggestionId,
    provider: out.provider,
    model: out.model,
    result: out.result,
    ...(out.message ? { message: out.message } : {}),
  });
});
