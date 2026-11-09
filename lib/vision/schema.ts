// The shape of a suggested count, and the cleanup applied to whatever the
// model returns before anyone sees it. The volunteer always confirms the
// numbers; this only makes sure the screen never shows something malformed.

import { z } from "zod";

export const MAX_COUNT = 500;
export const GRID = 1000;
const MAX_UNKNOWN = 20;
const MAX_QUALITY = 10;

/** [ymin, xmin, ymax, xmax] on a 0–1000 grid over the photo. */
export const BoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

export const CountItemSchema = z.object({
  sku: z.string(),
  count: z.number().int().min(0),
  confidence: ConfidenceSchema,
  boxes: z.array(BoxSchema),
});

export const CountResultSchema = z.object({
  items: z.array(CountItemSchema),
  unknown: z.array(z.object({ label: z.string(), count: z.number().int().min(0) })),
  quality: z.array(z.string()),
});

export type Box = z.infer<typeof BoxSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type CountItem = z.infer<typeof CountItemSchema>;
export type CountResult = z.infer<typeof CountResultSchema>;

export interface CatalogRef {
  sku: string;
  name: string;
  description?: string;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toCount(v: unknown): number | null {
  const num = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.min(MAX_COUNT, Math.max(0, Math.round(num)));
}

function toConfidence(v: unknown): Confidence {
  const parsed = ConfidenceSchema.safeParse(typeof v === "string" ? v.trim().toLowerCase() : v);
  return parsed.success ? parsed.data : "low";
}

function clampCoord(v: number): number {
  return Math.min(GRID, Math.max(0, Math.round(v)));
}

/** A box is kept only if it has four finite numbers and some area after clamping. */
export function cleanBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  if (!v.every((c) => typeof c === "number" && Number.isFinite(c))) return null;
  const [a, b, c, d] = (v as number[]).map(clampCoord) as [number, number, number, number];
  const box: Box = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  if (box[2] - box[0] < 1 || box[3] - box[1] < 1) return null;
  return box;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Turn a raw model answer into a CountResult for this catalog.
 * - items whose sku is not on the menu move to `unknown`
 * - counts become integers in 0..500; boxes are clamped to the grid, malformed ones dropped
 * - every catalog sku appears exactly once, in catalog order (count 0, confidence low if the model skipped it)
 * Throws if the answer is not an object with an `items` array, so the caller can fall back to counting by hand.
 */
export function normalizeResult(raw: unknown, catalog: readonly CatalogRef[]): CountResult {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new Error("The photo count came back in an unexpected shape.");
  }

  // Models sometimes echo the display name or change case; match either.
  const lookup = new Map<string, string>();
  for (const item of catalog) {
    lookup.set(item.sku.toLowerCase(), item.sku);
    lookup.set(item.name.toLowerCase(), item.sku);
  }

  const found = new Map<string, CountItem>();
  const unknown = new Map<string, number>();

  for (const entry of raw.items) {
    if (!isRecord(entry)) continue;
    const label = cleanText(entry.sku, 80);
    if (!label) continue;
    const boxes = Array.isArray(entry.boxes)
      ? entry.boxes.map(cleanBox).filter((b): b is Box => b !== null).slice(0, MAX_COUNT)
      : [];
    const count = toCount(entry.count) ?? boxes.length;
    const sku = lookup.get(label.toLowerCase());

    if (!sku) {
      if (count > 0) unknown.set(label, Math.min(MAX_COUNT, (unknown.get(label) ?? 0) + count));
      continue;
    }

    const confidence = toConfidence(entry.confidence);
    const prev = found.get(sku);
    if (!prev) {
      found.set(sku, { sku, count, confidence, boxes });
    } else {
      // The same item listed twice is usually two groups on the table: add them up
      // and keep the less certain confidence.
      found.set(sku, {
        sku,
        count: Math.min(MAX_COUNT, prev.count + count),
        confidence: CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[prev.confidence] ? confidence : prev.confidence,
        boxes: [...prev.boxes, ...boxes].slice(0, MAX_COUNT),
      });
    }
  }

  if (Array.isArray(raw.unknown)) {
    for (const entry of raw.unknown) {
      if (!isRecord(entry)) continue;
      const label = cleanText(entry.label, 80);
      const count = toCount(entry.count);
      if (!label || count === null || count === 0) continue;
      unknown.set(label, Math.min(MAX_COUNT, (unknown.get(label) ?? 0) + count));
    }
  }

  const quality: string[] = [];
  if (Array.isArray(raw.quality)) {
    for (const q of raw.quality) {
      const t = cleanText(q, 200);
      if (t && !quality.some((x) => x.toLowerCase() === t.toLowerCase())) quality.push(t);
      if (quality.length >= MAX_QUALITY) break;
    }
  }

  const result: CountResult = {
    items: catalog.map((c) => found.get(c.sku) ?? { sku: c.sku, count: 0, confidence: "low", boxes: [] }),
    unknown: [...unknown].slice(0, MAX_UNKNOWN).map(([label, count]) => ({ label, count })),
    quality,
  };
  return CountResultSchema.parse(result);
}

/** sku -> count, the form the counts API and the editor use. */
export function countsOf(result: CountResult): Record<string, number> {
  return Object.fromEntries(result.items.map((i) => [i.sku, i.count]));
}
