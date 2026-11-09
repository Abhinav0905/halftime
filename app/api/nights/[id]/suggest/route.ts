import { z } from "zod";
import { visionConfig } from "@/lib/config";
import { db } from "@/lib/db";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { SHA256_RE, readPhoto } from "@/lib/photos";
import { audit, getNight, getSuggestion, listItems, saveSuggestion, type CountKind, type Suggestion } from "@/lib/repo";
import { suggestCounts, type CatalogRef } from "@/lib/vision";
import { normalizeResult } from "@/lib/vision/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(["open", "close"]),
  sha256: z.string().regex(SHA256_RE, "expected a 64-character photo id"),
});

const REPLAY_PREFIX = "replay:";

function latestSuggestion(nightId: string, kind: CountKind, sha256: string): Suggestion | null {
  const row = db()
    .prepare("SELECT id FROM suggestion WHERE night_id = ? AND kind = ? AND photo_sha256 = ? ORDER BY created_at DESC LIMIT 1")
    .get(nightId, kind, sha256) as { id: string } | undefined;
  return row ? getSuggestion(String(row.id)) : null;
}

function reuse(prior: Suggestion, catalog: readonly CatalogRef[]) {
  try {
    const replayed = prior.model.startsWith(REPLAY_PREFIX);
    return {
      suggestionId: prior.id,
      provider: replayed ? ("replay" as const) : ("gemini" as const),
      model: replayed ? prior.model.slice(REPLAY_PREFIX.length) : prior.model,
      // Re-normalize in case the menu changed since it was stored.
      result: normalizeResult(prior.result, catalog),
    };
  } catch {
    return null;
  }
}

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!getNight(id)) throw new HttpError(404, "That game night was not found.");
  const { kind, sha256 } = await readJson(req, Body);
  const catalog = listItems();

  // A retry, a reload or a second tap on the same photo gets the stored answer
  // instead of paying for another model call.
  if (visionConfig().provider !== "manual") {
    const prior = latestSuggestion(id, kind, sha256);
    const reused = prior && reuse(prior, catalog);
    if (reused) return ok(reused);
  }

  const photo = readPhoto(sha256);
  if (!photo) throw new HttpError(404, "That photo was not found. Please take it again.");

  const out = await suggestCounts({ nightId: id, sha256, bytes: photo.bytes, mime: photo.mime, catalog });

  if (!out.result) {
    audit(id, null, "suggestion.unavailable", { kind, sha256, provider: out.provider, model: out.model });
    return ok({ suggestionId: null, provider: out.provider, model: out.model, result: null, message: out.message });
  }

  const suggestionId = saveSuggestion({
    nightId: id,
    kind,
    photoSha256: sha256,
    // Keep replayed answers distinguishable from live ones in the stored record.
    model: out.provider === "replay" ? `${REPLAY_PREFIX}${out.model ?? "recorded"}` : out.model ?? out.provider,
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
