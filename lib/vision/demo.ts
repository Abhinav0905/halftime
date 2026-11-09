// The demo photos in public/demo/ let anyone try the photo count without a
// camera or an API key. The count screen offers them when the files exist, and
// `npm run demo:record` stores the model's answer for each one in eval/recorded/
// so replay mode can show a real suggestion.

import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../sha256";
import { recordedDir, writeRecording } from "./replay";
import type { CountResult } from "./schema";

export type DemoKind = "open" | "close";
export const DEMO_KINDS: readonly DemoKind[] = ["open", "close"];

export function demoDir(): string {
  return path.join(process.cwd(), "public", "demo");
}

/** Where the demo photo for this count is served from, or null when the file is not there. */
export function demoPhotoUrl(kind: DemoKind, dir = demoDir()): string | null {
  return fs.existsSync(path.join(dir, `${kind}.jpg`)) ? `/demo/${kind}.jpg` : null;
}

export interface DemoRecording {
  kind: DemoKind;
  file: string;
  sha256: string | null;
  bytes: number;
  result: CountResult | null;
  recordingFile: string | null;
  /** Older recordings of the same demo photo that were deleted because the photo changed. */
  removed: string[];
  error: string | null;
}

export async function recordDemoPhotos(opts: {
  model: string;
  count: (bytes: Buffer, mime: string) => Promise<CountResult>;
  kinds?: readonly DemoKind[];
  dir?: string;
  recorded?: string;
  maxBytes?: number;
}): Promise<DemoRecording[]> {
  const dir = opts.dir ?? demoDir();
  const recorded = opts.recorded ?? recordedDir();
  const out: DemoRecording[] = [];

  for (const kind of opts.kinds ?? DEMO_KINDS) {
    const file = path.join(dir, `${kind}.jpg`);
    const base: DemoRecording = { kind, file, sha256: null, bytes: 0, result: null, recordingFile: null, removed: [], error: null };
    if (!fs.existsSync(file)) {
      out.push({ ...base, error: "not found" });
      continue;
    }
    const bytes = fs.readFileSync(file);
    const sha256 = sha256Hex(bytes);
    if (opts.maxBytes && bytes.length > opts.maxBytes) {
      out.push({ ...base, sha256, bytes: bytes.length, error: `larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB, so the app would refuse the upload` });
      continue;
    }
    try {
      const result = await opts.count(bytes, "image/jpeg");
      // The source names the demo slot, not the image, so a reshoot can find and replace the old recording.
      const source = `public/demo/${kind}.jpg`;
      const recordingFile = writeRecording({ sha256, model: opts.model, recordedAt: new Date().toISOString(), source, result }, recorded);
      out.push({ ...base, sha256, bytes: bytes.length, result, recordingFile, removed: removeStale(recorded, source, sha256) });
    } catch (err) {
      out.push({ ...base, sha256, bytes: bytes.length, error: (err as Error).message });
    }
  }
  return out;
}

function removeStale(recorded: string, source: string, keep: string): string[] {
  const removed: string[] = [];
  for (const name of fs.readdirSync(recorded)) {
    if (!name.endsWith(".json") || name === `${keep}.json`) continue;
    const full = path.join(recorded, name);
    try {
      const rec = JSON.parse(fs.readFileSync(full, "utf8")) as { source?: unknown };
      if (rec.source !== source) continue;
      fs.unlinkSync(full);
      removed.push(full);
    } catch {
      // Not a recording this script wrote; leave it alone.
    }
  }
  return removed;
}
