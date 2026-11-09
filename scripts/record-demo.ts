// Records the photo count for the demo photos, so the count screen's
// "Use the demo photo" option shows a real suggestion even with no API key.
//
//   npm run demo:record                    public/demo/open.jpg and public/demo/close.jpg
//   npm run demo:record -- --only close
//   npm run demo:record -- --model gemini-3.5-flash
//
// Needs GEMINI_API_KEY (from the shell or .env.local). Writes one
// eval/recorded/<sha256>.json per photo and deletes the recording of an older
// version of the same photo. Commit the photos and recordings together.

import fs from "node:fs";
import path from "node:path";
import { visionConfig } from "../lib/config";
import { MAX_PHOTO_BYTES } from "../lib/photos";
import { ITEMS } from "../lib/seed";
import { DEMO_KINDS, recordDemoPhotos, type DemoKind } from "../lib/vision/demo";
import { countWithGemini } from "../lib/vision/gemini";

const ROOT = path.resolve(__dirname, "..");
// Bigger files still upload, but they are slow on a phone connection.
const COMFORTABLE_BYTES = 2.5 * 1024 * 1024;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function rel(file: string): string {
  const r = path.relative(ROOT, file);
  return r.startsWith("..") ? file : r;
}

async function main() {
  const envFile = path.join(ROOT, ".env.local");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const cfg = visionConfig();
  if (!cfg.apiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env.local or the shell and run again.");
  const model = arg("model") ?? cfg.model;
  const only = arg("only");
  if (only && !DEMO_KINDS.includes(only as DemoKind)) throw new Error("--only must be open or close.");

  const dir = path.join(ROOT, "public", "demo");
  const recorded = process.env.HALFTIME_RECORDED || path.join(ROOT, "eval", "recorded");
  const catalog = ITEMS.map((i) => ({ sku: i.sku, name: i.name, description: i.description }));
  console.log(`Recording the demo photos in ${rel(dir)} with ${model}\n`);

  const results = await recordDemoPhotos({
    model,
    dir,
    recorded,
    kinds: only ? [only as DemoKind] : DEMO_KINDS,
    maxBytes: MAX_PHOTO_BYTES,
    count: async (bytes, mime) => (await countWithGemini({ bytes, mime, catalog, apiKey: cfg.apiKey, model })).result,
  });

  for (const r of results) {
    const name = `${r.kind}.jpg`.padEnd(10);
    if (r.error) {
      console.log(`  ${name} ${r.error === "not found" ? "not found, skipped" : `failed: ${r.error}`}`);
      continue;
    }
    const counts = r.result!.items.map((i) => `${i.sku} ${i.count}${i.confidence === "high" ? "" : ` (${i.confidence})`}`).join("  ");
    console.log(`  ${name} ${counts}`);
    if (r.result!.quality.length) console.log(`  ${"".padEnd(10)} photo notes: ${r.result!.quality.join("; ")}`);
    if (r.bytes > COMFORTABLE_BYTES) console.log(`  ${"".padEnd(10)} ${(r.bytes / 1024 / 1024).toFixed(1)} MB; export at 1600 px to keep the demo quick on a phone`);
    console.log(`  ${"".padEnd(10)} wrote ${rel(r.recordingFile!)}`);
    for (const old of r.removed) console.log(`  ${"".padEnd(10)} removed the old recording ${rel(old)}`);
  }

  const recordedCount = results.filter((r) => !r.error).length;
  if (!recordedCount) {
    console.error(`\nNo demo photos were recorded. See ${rel(path.join(dir, "README.md"))} for what to shoot.`);
    process.exit(1);
  }
  console.log("\nCheck these numbers against the table in each photo. Then commit the photos and the recordings together.");
  if (results.some((r) => r.error && r.error !== "not found")) process.exit(1);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
