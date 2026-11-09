import { z } from "zod";
import type { Counts } from "@/lib/engine/reconcile";
import { checkCountPeople } from "@/lib/engine/rules";
import { publish } from "@/lib/events";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import { SHA256_RE } from "@/lib/photos";
import {
  audit, getCounts, getNight, getPhoto, getSuggestion, listItems, listOrders, saveCount, setNightStatus, tx,
  type Item, type NightStatus,
} from "@/lib/repo";
import { CountResultSchema } from "@/lib/vision/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CountMap = z.record(z.string().min(1).max(32), z.number().int().min(0).max(9999));

const Body = z.object({
  kind: z.enum(["open", "close"]),
  counts: CountMap,
  waste: CountMap.nullish(),
  countedBy: z.string().max(80),
  checkedBy: z.string().max(80),
  sha256: z.string().regex(SHA256_RE, "expected a 64-character photo id").nullish(),
  suggestionId: z.string().max(64).nullish(),
});

function unknownSkus(map: Counts, skus: Set<string>): string[] {
  return Object.keys(map).filter((k) => !skus.has(k));
}

/** Per-item differences between what the photo count suggested and what the volunteers confirmed. */
function compareToSuggestion(items: Item[], suggested: Counts, confirmed: Counts) {
  const changes = items
    .map((i) => ({ sku: i.sku, suggested: suggested[i.sku] ?? 0, confirmed: confirmed[i.sku] ?? 0 }))
    .filter((c) => c.suggested !== c.confirmed);
  return {
    items: items.length,
    itemsChanged: changes.length,
    unitsChanged: changes.reduce((s, c) => s + Math.abs(c.confirmed - c.suggested), 0),
    changes,
  };
}

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!getNight(id)) throw new HttpError(404, "That game night was not found.");
  const body = await readJson(req, Body);
  const { kind, counts } = body;

  const peopleError = checkCountPeople(body.countedBy, body.checkedBy);
  if (peopleError) throw new HttpError(400, peopleError);

  const items = listItems();
  const skus = new Set(items.map((i) => i.sku));
  const extra = unknownSkus(counts, skus);
  if (extra.length) throw new HttpError(400, `Not on the menu: ${extra.join(", ")}.`);
  const missing = items.filter((i) => counts[i.sku] === undefined);
  if (missing.length) throw new HttpError(400, `Enter a count for every item. Missing: ${missing.map((i) => i.name).join(", ")}.`);

  let waste: Counts | null = null;
  if (body.waste) {
    const extraWaste = unknownSkus(body.waste, skus);
    if (extraWaste.length) throw new HttpError(400, `Not on the menu: ${extraWaste.join(", ")}.`);
    if (kind === "open" && Object.values(body.waste).some((w) => w > 0)) {
      throw new HttpError(400, "Waste is recorded with the closing count.");
    }
  }
  if (kind === "close") {
    waste = Object.fromEntries(items.map((i) => [i.sku, body.waste?.[i.sku] ?? 0]));
  }
  const cleanCounts: Counts = Object.fromEntries(items.map((i) => [i.sku, counts[i.sku] ?? 0]));

  const suggestion = body.suggestionId ? getSuggestion(body.suggestionId) : null;
  if (body.suggestionId && (!suggestion || suggestion.nightId !== id || suggestion.kind !== kind)) {
    throw new HttpError(400, "That suggested count belongs to a different game or count.");
  }
  if (suggestion && body.sha256 && suggestion.photoSha256 !== body.sha256) {
    throw new HttpError(400, "The suggested count was made from a different photo.");
  }
  const photoSha256 = body.sha256 ?? suggestion?.photoSha256 ?? null;
  if (photoSha256 && !getPhoto(photoSha256)) throw new HttpError(400, "That photo was not found. Please take it again.");

  const countedBy = body.countedBy.trim();
  const checkedBy = body.checkedBy.trim();

  // Status checks and the write share one transaction so an order captured
  // at the same moment cannot slip in between them.
  const { status, changed } = tx(() => {
    const night = getNight(id);
    if (!night) throw new HttpError(404, "That game night was not found.");
    let next: NightStatus = night.status;

    if (kind === "open") {
      // A refunded order was paid first, so it also means sales have started.
      const salesStarted = listOrders(id).some((o) => o.status === "COMPLETED" || o.status === "REFUNDED");
      if (!(night.status === "setup" || night.status === "selling") || salesStarted) {
        throw new HttpError(409, "Sales have started, so the opening count is locked.");
      }
      next = "selling";
    } else {
      if (night.status === "setup") throw new HttpError(409, "Save the opening count before the closing count.");
      if (!(night.status === "selling" || night.status === "closing")) {
        throw new HttpError(409, "This game is finalized, so the closing count is locked.");
      }
      next = "closing";
    }

    const previous = getCounts(id)[kind];
    saveCount({ nightId: id, kind, counts: cleanCounts, waste, photoSha256, suggestionId: suggestion?.id ?? null, countedBy, checkedBy });
    if (next !== night.status) setNightStatus(id, next);

    audit(id, countedBy, "count.saved", {
      kind, counts: cleanCounts, waste, countedBy, checkedBy, sha256: photoSha256, suggestionId: suggestion?.id ?? null,
      ...(previous ? { replaced: { counts: previous.counts, waste: previous.waste, countedBy: previous.countedBy, at: previous.createdAt } } : {}),
    });

    if (suggestion) {
      const parsed = CountResultSchema.safeParse(suggestion.result);
      if (parsed.success) {
        const suggested = Object.fromEntries(parsed.data.items.map((i) => [i.sku, i.count]));
        audit(id, countedBy, "count.compared_to_suggestion", {
          kind, suggestionId: suggestion.id, model: suggestion.model, ...compareToSuggestion(items, suggested, cleanCounts),
        });
      }
    }
    return { status: next, changed: next !== night.status };
  });

  publish(id, { type: "count.saved", kind });
  if (changed) publish(id, { type: "night.status", status });
  return ok({ ok: true, status });
});
