import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chipCount } from "@/components/count/BoxOverlay";
import { isLocalOnlyUrl } from "@/components/requestBaseUrl";
import { MESSAGES, MODEL_CALLS_PER_HOUR, MODEL_CALLS_PER_HOUR_ALL_GAMES, resetModelCallLimitsForTests, suggestCounts } from "@/lib/vision";
import { demoPhotoUrl, recordDemoPhotos } from "@/lib/vision/demo";
import { buildCountPrompt } from "@/lib/vision/prompt";
import { countResponseSchema } from "@/lib/vision/gemini";
import { createRateLimiter } from "@/lib/vision/limit";
import { findRecording, writeRecording } from "@/lib/vision/replay";
import { CountResultSchema, cleanBox, countsOf, normalizeResult } from "@/lib/vision/schema";
import { sha256Hex } from "@/lib/sha256";

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
    const r = normalizeResult(
      { items: [{ sku: "Hot Dog", count: 2, confidence: "HIGH", boxes: [[0, 0, 10, 10], [20, 20, 30, 30]] }, { sku: "WATER", count: 1 }] },
      catalog,
    );
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

  it("keeps the model's count when the boxes differ, but never calls that high confidence", () => {
    const box = [0, 0, 10, 10];
    const r = normalizeResult(
      {
        items: [
          { sku: "water", count: 3, confidence: "high", boxes: [box, box] },
          { sku: "chips", count: 2, confidence: "high", boxes: [box, box] },
          { sku: "hotdog", count: 4, confidence: "low", boxes: [box] },
        ],
      },
      catalog,
    );
    expect(r.items.map((i) => [i.count, i.boxes.length, i.confidence])).toEqual([
      [3, 2, "medium"],
      [2, 2, "high"],
      [4, 1, "low"],
    ]);
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

describe("overlay chips", () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];

  it("show the suggested count, and how many are boxed when that differs", () => {
    expect(chipCount({ count: 2, boxes: [box, box] })).toBe("2");
    expect(chipCount({ count: 12, boxes: Array(10).fill(box) })).toBe("12 (10 boxed)");
    expect(chipCount({ count: 0, boxes: [] })).toBe("0");
  });
});

describe("booth QR address", () => {
  it("spots addresses a phone cannot reach", () => {
    for (const url of ["http://localhost:3000/m/n1", "http://127.0.0.1:3000/m/n1", "http://[::1]:3000/m/n1", "http://0.0.0.0:3000/m/n1", "http://app.localhost/m/n1"]) {
      expect(isLocalOnlyUrl(url)).toBe(true);
    }
    for (const url of ["http://192.168.1.20:3000/m/n1", "https://halftime.onrender.com/m/n1", "not a url"]) {
      expect(isLocalOnlyUrl(url)).toBe(false);
    }
  });
});

describe("model call limit", () => {
  it("allows max calls per key in a sliding window", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000 });
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 10)).toBe(true);
    expect(limiter.take("a", 20)).toBe(false);
    expect(limiter.take("b", 20)).toBe(true);
    expect(limiter.take("a", 1000)).toBe(true);
    expect(limiter.take("a", 1005)).toBe(false);
    expect(limiter.take("a", 1010)).toBe(true);
  });

  it("can check a key without using up a call", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.allows("a", 0)).toBe(true);
    expect(limiter.allows("a", 0)).toBe(true);
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.allows("a", 10)).toBe(false);
    expect(limiter.allows("a", 1000)).toBe(true);
    limiter.reset();
    expect(limiter.take("a", 10)).toBe(true);
  });
});

function geminiReply(result: unknown) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] }, finishReason: "STOP" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("suggestCounts with Gemini", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-suggest-"));
  const env = { ...process.env };
  const input = (nightId: string, sha256 = "d".repeat(64)) => ({ nightId, sha256, bytes: Buffer.from("photo"), mime: "image/jpeg", catalog });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetModelCallLimitsForTests();
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.VISION_PROVIDER;
    process.env.HALFTIME_RECORDED = dir;
    fetchMock = vi.fn(async () => geminiReply({ items: [{ sku: "water", count: 1, confidence: "high", boxes: [[0, 0, 10, 10]] }], unknown: [], quality: [] }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("stops calling the model for a night after the hourly limit, with a plain message", async () => {
    for (let i = 0; i < MODEL_CALLS_PER_HOUR; i++) {
      expect((await suggestCounts(input("busy-night"))).provider).toBe("gemini");
    }
    const limited = await suggestCounts(input("busy-night"));
    expect(limited).toMatchObject({ result: null, message: MESSAGES.busy });
    expect(fetchMock).toHaveBeenCalledTimes(MODEL_CALLS_PER_HOUR);

    // Other nights are not affected.
    expect((await suggestCounts(input("other-night"))).result).not.toBeNull();
  });

  it("stops calling the model across all games after the overall hourly limit, with the same message", async () => {
    // New games each get their own per-game allowance, so the overall limit is what stops this.
    const games = Math.ceil(MODEL_CALLS_PER_HOUR_ALL_GAMES / MODEL_CALLS_PER_HOUR);
    for (let i = 0; i < MODEL_CALLS_PER_HOUR_ALL_GAMES; i++) {
      expect((await suggestCounts(input(`game-${i % games}`))).result).not.toBeNull();
    }
    const limited = await suggestCounts(input("brand-new-game"));
    expect(limited).toMatchObject({ result: null, message: MESSAGES.busy });
    expect(fetchMock).toHaveBeenCalledTimes(MODEL_CALLS_PER_HOUR_ALL_GAMES);
  });

  it("falls back to a recording when the limit is reached", async () => {
    const sha = "e".repeat(64);
    writeRecording({ sha256: sha, model: "gemini-test", recordedAt: null, source: null, result: { items: [{ sku: "chips", count: 4, confidence: "high", boxes: [] }], unknown: [], quality: [] } }, dir);
    for (let i = 0; i < MODEL_CALLS_PER_HOUR; i++) await suggestCounts(input("demo-night", sha));
    const limited = await suggestCounts(input("demo-night", sha));
    expect(limited.provider).toBe("replay");
    expect(limited.result && countsOf(limited.result).chips).toBe(4);
  });
});

describe("demo photos", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-demo-"));
  const photos = path.join(root, "demo");
  const recorded = path.join(root, "recorded");
  fs.mkdirSync(photos);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const answer = (water: number) => ({ items: [{ sku: "water", count: water, confidence: "high" as const, boxes: [] }], unknown: [], quality: [] });

  it("are offered only when the file is there", () => {
    expect(demoPhotoUrl("open", photos)).toBeNull();
    fs.writeFileSync(path.join(photos, "open.jpg"), Buffer.from([0xff, 0xd8, 0xff, 1]));
    expect(demoPhotoUrl("open", photos)).toBe("/demo/open.jpg");
    expect(demoPhotoUrl("close", photos)).toBeNull();
  });

  it("record a count the app can replay by the photo's SHA-256, and skip missing photos", async () => {
    const count = vi.fn(async () => answer(12));
    const out = await recordDemoPhotos({ model: "gemini-test", count, dir: photos, recorded });
    expect(out.map((r) => [r.kind, r.error])).toEqual([["open", null], ["close", "not found"]]);
    expect(count).toHaveBeenCalledTimes(1);

    const sha = sha256Hex(fs.readFileSync(path.join(photos, "open.jpg")));
    expect(out[0]!.sha256).toBe(sha);
    const rec = findRecording(sha, catalog, recorded);
    expect(rec?.source).toBe("public/demo/open.jpg");
    expect(rec && countsOf(rec.result).water).toBe(12);
  });

  it("replace the recording of an older version of the same photo", async () => {
    const oldSha = sha256Hex(fs.readFileSync(path.join(photos, "open.jpg")));
    fs.writeFileSync(path.join(photos, "open.jpg"), Buffer.from([0xff, 0xd8, 0xff, 2]));
    const out = await recordDemoPhotos({ model: "gemini-test", count: async () => answer(10), dir: photos, recorded, kinds: ["open"] });
    expect(out[0]!.removed).toEqual([path.join(recorded, `${oldSha}.json`)]);
    expect(findRecording(oldSha, catalog, recorded)).toBeNull();
    expect(fs.readdirSync(recorded)).toEqual([`${out[0]!.sha256}.json`]);
  });

  it("refuse a photo the app would not accept as an upload", async () => {
    const count = vi.fn(async () => answer(1));
    const out = await recordDemoPhotos({ model: "gemini-test", count, dir: photos, recorded, kinds: ["open"], maxBytes: 2 });
    expect(out[0]!.error).toMatch(/larger than/);
    expect(count).not.toHaveBeenCalled();
  });
});
