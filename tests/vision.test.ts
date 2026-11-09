import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCountPrompt } from "@/lib/vision/prompt";
import { countResponseSchema } from "@/lib/vision/gemini";
import { findRecording, writeRecording } from "@/lib/vision/replay";
import { CountResultSchema, cleanBox, countsOf, normalizeResult } from "@/lib/vision/schema";

const catalog = [
  { sku: "water", name: "Water", description: "clear plastic bottle" },
  { sku: "chips", name: "Chips", description: "bag of chips" },
  { sku: "hotdog", name: "Hot dog", description: "foil-wrapped hot dog" },
];

describe("CountResultSchema", () => {
  it("accepts the contract shape", () => {
    const ok = CountResultSchema.safeParse({
      items: [{ sku: "water", count: 2, confidence: "high", boxes: [[0, 0, 10, 10], [20, 20, 40, 40]] }],
      unknown: [{ label: "napkins", count: 1 }],
      quality: [],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects fractional counts, bad confidence and short boxes", () => {
    const base = { unknown: [], quality: [] };
    expect(CountResultSchema.safeParse({ ...base, items: [{ sku: "a", count: 1.5, confidence: "high", boxes: [] }] }).success).toBe(false);
    expect(CountResultSchema.safeParse({ ...base, items: [{ sku: "a", count: 1, confidence: "sure", boxes: [] }] }).success).toBe(false);
    expect(CountResultSchema.safeParse({ ...base, items: [{ sku: "a", count: 1, confidence: "low", boxes: [[1, 2, 3]] }] }).success).toBe(false);
  });
});

describe("normalizeResult", () => {
  it("lists every catalog sku once, in catalog order, filling gaps with 0", () => {
    const r = normalizeResult({ items: [{ sku: "chips", count: 3, confidence: "high", boxes: [] }], unknown: [], quality: [] }, catalog);
    expect(r.items.map((i) => i.sku)).toEqual(["water", "chips", "hotdog"]);
    expect(countsOf(r)).toEqual({ water: 0, chips: 3, hotdog: 0 });
    expect(r.items[0]!.confidence).toBe("low");
  });

  it("moves skus that are not on the menu into unknown", () => {
    const r = normalizeResult(
      { items: [{ sku: "napkins", count: 4, confidence: "high", boxes: [] }], unknown: [{ label: "napkins", count: 1 }], quality: [] },
      catalog,
    );
    expect(r.unknown).toEqual([{ label: "napkins", count: 5 }]);
    expect(r.items.every((i) => i.count === 0)).toBe(true);
  });

  it("matches display names and case", () => {
    const r = normalizeResult({ items: [{ sku: "Hot Dog", count: 2, confidence: "HIGH", boxes: [] }, { sku: "WATER", count: 1 }] }, catalog);
    expect(countsOf(r)).toEqual({ water: 1, chips: 0, hotdog: 2 });
    expect(r.items[2]!.confidence).toBe("high");
    expect(r.items[0]!.confidence).toBe("low");
  });

  it("clamps counts to whole numbers between 0 and 500", () => {
    const r = normalizeResult(
      { items: [{ sku: "water", count: -3 }, { sku: "chips", count: 2.6 }, { sku: "hotdog", count: 9000 }] },
      catalog,
    );
    expect(countsOf(r)).toEqual({ water: 0, chips: 3, hotdog: 500 });
  });

  it("accepts numeric strings and falls back to the number of boxes when count is missing", () => {
    const r = normalizeResult(
      { items: [{ sku: "water", count: "7" }, { sku: "chips", boxes: [[0, 0, 100, 100], [100, 100, 200, 200]] }] },
      catalog,
    );
    expect(countsOf(r)).toMatchObject({ water: 7, chips: 2 });
  });

  it("adds up an item listed twice and keeps the lower confidence", () => {
    const r = normalizeResult(
      {
        items: [
          { sku: "water", count: 3, confidence: "high", boxes: [[0, 0, 10, 10]] },
          { sku: "water", count: 2, confidence: "medium", boxes: [[20, 20, 30, 30]] },
        ],
      },
      catalog,
    );
    expect(r.items[0]).toMatchObject({ count: 5, confidence: "medium" });
    expect(r.items[0]!.boxes).toHaveLength(2);
  });

  it("clamps boxes to the grid, fixes reversed corners and drops malformed ones", () => {
    const r = normalizeResult(
      {
        items: [{
          sku: "water",
          count: 4,
          confidence: "high",
          boxes: [[-50, 10, 1200, 90], [500, 600, 400, 300], [1, 2, 3], ["a", 0, 10, 10], [5, 5, 5, 50], null, [0, 0, Infinity, 10]],
        }],
      },
      catalog,
    );
    expect(r.items[0]!.boxes).toEqual([[0, 10, 1000, 90], [400, 300, 500, 600]]);
  });

  it("cleans quality notes and unknown labels", () => {
    const r = normalizeResult(
      {
        items: [],
        unknown: [{ label: "  cash   box ", count: 1 }, { label: "", count: 2 }, { label: "cups", count: 0 }, "x"],
        quality: ["Glare", "glare", "  ", 42, "items stacked"],
      },
      catalog,
    );
    expect(r.unknown).toEqual([{ label: "cash box", count: 1 }]);
    expect(r.quality).toEqual(["Glare", "items stacked"]);
  });

  it("throws when the answer is not an object with an items array", () => {
    expect(() => normalizeResult(null, catalog)).toThrow();
    expect(() => normalizeResult("[]", catalog)).toThrow();
    expect(() => normalizeResult({ counts: {} }, catalog)).toThrow();
    expect(() => normalizeResult([{ sku: "water" }], catalog)).toThrow();
  });

  it("always produces something the contract schema accepts", () => {
    const r = normalizeResult({ items: [{ sku: "chips", count: 1, confidence: 7, boxes: "none" }], unknown: "x", quality: null }, catalog);
    expect(CountResultSchema.safeParse(r).success).toBe(true);
  });
});

describe("cleanBox", () => {
  it("rounds to integers", () => {
    expect(cleanBox([10.4, 20.6, 30.5, 40.49])).toEqual([10, 21, 31, 40]);
  });
});

describe("prompt and response schema", () => {
  it("names every menu item and never asks about money", () => {
    const p = buildCountPrompt(catalog);
    for (const c of catalog) expect(p).toContain(`"${c.sku}"`);
    expect(p).toMatch(/Do not estimate prices/);
  });

  it("limits the sku field to the menu", () => {
    const s = countResponseSchema(["water", "chips"]);
    expect(s.properties.items.items.properties.sku.enum).toEqual(["water", "chips"]);
  });
});

describe("replay recordings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-replay-"));
  const sha = "a".repeat(64);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns null when there is no recording or the id is not a hash", () => {
    expect(findRecording(sha, catalog, dir)).toBeNull();
    expect(findRecording("../../etc/passwd", catalog, dir)).toBeNull();
    expect(findRecording("A".repeat(64), catalog, dir)).toBeNull();
  });

  it("round-trips a recording and re-normalizes it against the current menu", () => {
    writeRecording(
      {
        sha256: sha, model: "gemini-test", recordedAt: "2026-11-08T00:00:00.000Z", source: "rows-01.jpg",
        result: { items: [{ sku: "water", count: 2, confidence: "high", boxes: [[0, 0, 10, 10]] }], unknown: [], quality: [] },
      },
      dir,
    );
    const rec = findRecording(sha, catalog, dir);
    expect(rec?.model).toBe("gemini-test");
    expect(rec?.source).toBe("rows-01.jpg");
    expect(rec && countsOf(rec.result)).toEqual({ water: 2, chips: 0, hotdog: 0 });
  });

  it("accepts a bare CountResult file and ignores unreadable ones", () => {
    const bare = "b".repeat(64);
    fs.writeFileSync(path.join(dir, `${bare}.json`), JSON.stringify({ items: [{ sku: "chips", count: 4 }], unknown: [], quality: [] }));
    expect(findRecording(bare, catalog, dir)?.model).toBe("recorded");
    expect(findRecording(bare, catalog, dir) && countsOf(findRecording(bare, catalog, dir)!.result).chips).toBe(4);

    const broken = "c".repeat(64);
    fs.writeFileSync(path.join(dir, `${broken}.json`), "{ not json");
    expect(findRecording(broken, catalog, dir)).toBeNull();
  });
});
