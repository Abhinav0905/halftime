// Scores the photo count against hand-labelled photos.
//
//   npm run eval                          run the configured provider on eval/photos/*
//   npm run eval -- --provider replay     score the recorded answers instead (no API key; what CI runs)
//   npm run eval -- --record              also save each answer to eval/recorded/<sha256>.json for replay mode
//   npm run eval -- --model gemini-2.5-flash --only rows-shade-01.jpg
//   npm run eval -- --photos ~/shots --labels ~/shots/labels.json --recorded /tmp/rec
//
// Labels live in eval/labels.json: { "<photo file>": { "<sku>": count } }.
// An item missing from a label counts as 0.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { visionConfig } from "../lib/config";
import { ITEMS } from "../lib/seed";
import { countWithGemini } from "../lib/vision/gemini";
import { findRecording, writeRecording } from "../lib/vision/replay";
import type { CountResult } from "../lib/vision/schema";

const ROOT = path.resolve(__dirname, "..");
const EVAL_DIR = path.join(ROOT, "eval");
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const catalog = ITEMS.map((i) => ({ sku: i.sku, name: i.name, description: i.description }));
const skus: string[] = catalog.map((c) => c.sku);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function loadEnv() {
  try {
    process.loadEnvFile(path.join(ROOT, ".env.local"));
  } catch {
    // No .env.local: rely on the shell environment.
  }
}

interface ItemScore { label: number; predicted: number; diff: number }
interface PhotoScore {
  file: string;
  sha256: string;
  latencyMs: number | null;
  error: string | null;
  exact: boolean;
  items: Record<string, ItemScore>;
  unknown: CountResult["unknown"];
  quality: string[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(0)}%` : "n/a";
}

async function main() {
  loadEnv();
  const cfg = visionConfig();
  const provider = (arg("provider") ?? (cfg.provider === "manual" ? "replay" : cfg.provider)) as "gemini" | "replay";
  const model = arg("model") ?? cfg.model;
  const record = flag("record");
  const only = arg("only");
  // Assumptions for the PayPal floor estimate (see summary below).
  const sellThrough = Number(arg("sell-through") ?? 0.8);
  const paypalShare = Number(arg("paypal-share") ?? 0.5);
  const photoDir = path.resolve(arg("photos") ?? path.join(EVAL_DIR, "photos"));
  const labelsFile = path.resolve(arg("labels") ?? path.join(EVAL_DIR, "labels.json"));
  const resultsFile = path.resolve(arg("out") ?? path.join(EVAL_DIR, "results.json"));
  const recorded = arg("recorded") ? path.resolve(arg("recorded")!) : undefined;

  if (provider !== "gemini" && provider !== "replay") throw new Error(`Unknown provider: ${provider}`);
  if (provider === "gemini" && !cfg.apiKey) throw new Error("GEMINI_API_KEY is not set. Use --provider replay to score recorded answers.");
  if (record && provider !== "gemini") throw new Error("--record needs the gemini provider.");

  if (!fs.existsSync(labelsFile)) {
    console.error(`${path.relative(ROOT, labelsFile)} is missing. Copy eval/labels.example.json and fill in your own counts (see eval/README.md).`);
    process.exit(1);
  }
  const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8")) as Record<string, Record<string, number>>;
  const files = Object.keys(labels).filter((f) => !only || f === only);
  if (!files.length) {
    console.error("No labelled photos to score.");
    process.exit(1);
  }

  console.log(`Provider: ${provider}${provider === "gemini" ? ` (${model})` : ""}   photos: ${files.length}${record ? "   recording" : ""}\n`);

  const scores: PhotoScore[] = [];
  for (const file of files) {
    const label = labels[file]!;
    for (const sku of Object.keys(label)) {
      if (!skus.includes(sku)) console.warn(`  ${file}: label sku "${sku}" is not on the menu; ignored`);
    }
    const full = path.join(photoDir, file);
    const mime = MIME[path.extname(file).toLowerCase()];
    const base: PhotoScore = { file, sha256: "", latencyMs: null, error: null, exact: false, items: {}, unknown: [], quality: [] };
    if (!mime || !fs.existsSync(full)) {
      scores.push({ ...base, error: !mime ? "unsupported file type" : "photo file not found" });
      console.log(`  ${file.padEnd(32)} skipped: ${!mime ? "unsupported file type" : "photo file not found"}`);
      continue;
    }
    const bytes = fs.readFileSync(full);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

    let result: CountResult | null = null;
    let latencyMs: number | null = null;
    let error: string | null = null;
    try {
      if (provider === "gemini") {
        const out = await countWithGemini({ bytes, mime, catalog, apiKey: cfg.apiKey, model });
        result = out.result;
        latencyMs = out.latencyMs;
        if (record) writeRecording({ sha256, model, recordedAt: new Date().toISOString(), source: file, result }, recorded);
      } else {
        const rec = findRecording(sha256, catalog, recorded);
        if (!rec) throw new Error("no recording for this photo (run with --record first)");
        result = rec.result;
      }
    } catch (err) {
      error = (err as Error).message;
    }

    if (!result) {
      scores.push({ ...base, sha256, latencyMs, error });
      console.log(`  ${file.padEnd(32)} failed: ${error}`);
      continue;
    }

    const items: Record<string, ItemScore> = {};
    for (const sku of skus) {
      const want = label[sku] ?? 0;
      const got = result.items.find((i) => i.sku === sku)?.count ?? 0;
      items[sku] = { label: want, predicted: got, diff: got - want };
    }
    const exact = Object.values(items).every((i) => i.diff === 0);
    scores.push({ file, sha256, latencyMs, error: null, exact, items, unknown: result.unknown, quality: result.quality });

    const cells = skus.map((s) => {
      const i = items[s]!;
      return `${s} ${i.predicted}/${i.label}${i.diff === 0 ? "" : i.diff > 0 ? ` (+${i.diff})` : ` (${i.diff})`}`;
    });
    console.log(`  ${file.padEnd(32)} ${exact ? "exact" : "     "}  ${cells.join("  ")}${latencyMs !== null ? `  ${(latencyMs / 1000).toFixed(1)} s` : ""}`);
  }

  const scored = scores.filter((s) => !s.error);
  const pairs = scored.flatMap((s) => Object.entries(s.items).map(([sku, i]) => ({ sku, ...i })));
  const perItem = Object.fromEntries(
    skus.map((sku) => {
      const p = pairs.filter((x) => x.sku === sku);
      return [sku, {
        photos: p.length,
        exactRate: p.length ? p.filter((x) => x.diff === 0).length / p.length : null,
        mae: p.length ? p.reduce((s, x) => s + Math.abs(x.diff), 0) / p.length : null,
      }];
    }),
  );

  // PayPal floor estimate. Treat each photo as an opening count and suppose the night
  // sells `sellThrough` of the true stock, `paypalShare` of it through PayPal. An
  // undercount of d units makes "sold" look d too small; PayPal's itemized units exceed
  // that (and trigger a recount) only when d is larger than the item's cash units.
  // Overcounts are never caught this way; they show up as a cash shortfall instead.
  let undercounts = 0;
  let caught = 0;
  for (const p of pairs) {
    if (p.diff >= 0) continue;
    undercounts++;
    const sold = Math.round(p.label * sellThrough);
    const paypal = Math.round(sold * paypalShare);
    if (paypal > sold + p.diff) caught++;
  }

  const latencies = scored.map((s) => s.latencyMs).filter((x): x is number => x !== null);
  const summary = {
    photos: files.length,
    scored: scored.length,
    failed: scores.length - scored.length,
    photoExactRate: scored.length ? scored.filter((s) => s.exact).length / scored.length : null,
    itemExactRate: pairs.length ? pairs.filter((p) => p.diff === 0).length / pairs.length : null,
    meanAbsoluteError: pairs.length ? pairs.reduce((s, p) => s + Math.abs(p.diff), 0) / pairs.length : null,
    overcounts: pairs.filter((p) => p.diff > 0).length,
    undercounts,
    undercountsCaughtByPayPalFloor: caught,
    floorAssumptions: { sellThrough, paypalShare },
    medianLatencyMs: median(latencies),
    maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
    perItem,
  };

  fs.writeFileSync(
    resultsFile,
    `${JSON.stringify({ runAt: new Date().toISOString(), provider, model: provider === "gemini" ? model : "recorded", summary, photos: scores }, null, 2)}\n`,
  );

  const exactPhotos = scored.filter((s) => s.exact).length;
  const exactPairs = pairs.filter((p) => p.diff === 0).length;
  console.log("\nSummary");
  console.log(`  photos scored            ${scored.length} of ${files.length}${summary.failed ? ` (${summary.failed} failed)` : ""}`);
  console.log(`  every item exact         ${exactPhotos}/${scored.length} photos (${pct(exactPhotos, scored.length)})`);
  console.log(`  item counts exact        ${exactPairs}/${pairs.length} (${pct(exactPairs, pairs.length)})`);
  console.log(`  mean absolute error      ${summary.meanAbsoluteError === null ? "n/a" : summary.meanAbsoluteError.toFixed(2)} units per item`);
  console.log(`  over / under             ${summary.overcounts} over, ${undercounts} under`);
  console.log(`  PayPal floor             would flag ${caught} of ${undercounts} undercounts for a recount (assuming ${Math.round(sellThrough * 100)}% sold, ${Math.round(paypalShare * 100)}% of that on PayPal)`);
  if (latencies.length) console.log(`  latency                  median ${(summary.medianLatencyMs! / 1000).toFixed(1)} s, max ${(summary.maxLatencyMs! / 1000).toFixed(1)} s`);
  console.log("\n  per item                 exact   MAE");
  for (const sku of skus) {
    const s = perItem[sku]!;
    console.log(`  ${sku.padEnd(24)} ${s.exactRate === null ? " n/a" : pct(s.exactRate * s.photos, s.photos).padStart(4)}   ${s.mae === null ? "n/a" : s.mae.toFixed(2)}`);
  }
  const rel = path.relative(ROOT, resultsFile);
  console.log(`\nWrote ${rel.startsWith("..") ? resultsFile : rel}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
