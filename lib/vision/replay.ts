// Replay mode: recorded model answers keyed by the photo's SHA-256, so the count
// flow can show a real suggestion with no API key. The demo photos in public/demo/
// are recorded with `npm run demo:record`; eval photos with `npm run eval -- --record`.

import fs from "node:fs";
import path from "node:path";
import { SHA256_RE } from "../sha256";
import { normalizeResult, type CatalogRef, type CountResult } from "./schema";

export interface Recording {
  sha256: string;
  model: string;
  recordedAt: string | null;
  source: string | null;
  result: CountResult;
}

export function recordedDir(): string {
  return path.resolve(process.env.HALFTIME_RECORDED || path.join(process.cwd(), "eval", "recorded"));
}

export function recordingPath(sha256: string, dir = recordedDir()): string {
  if (!SHA256_RE.test(sha256)) throw new Error("Not a SHA-256 hex digest.");
  return path.join(dir, `${sha256}.json`);
}

/** Returns null when there is no recording for this photo or the file cannot be read. */
export function findRecording(sha256: string, catalog: readonly CatalogRef[], dir = recordedDir()): Recording | null {
  if (!SHA256_RE.test(sha256)) return null;
  let text: string;
  try {
    text = fs.readFileSync(recordingPath(sha256, dir), "utf8");
  } catch {
    return null;
  }
  try {
    const file = JSON.parse(text) as Record<string, unknown>;
    // A file may hold the bare CountResult or the envelope written by --record.
    const raw = "result" in file ? file.result : file;
    return {
      sha256,
      model: typeof file.model === "string" ? file.model : "recorded",
      recordedAt: typeof file.recordedAt === "string" ? file.recordedAt : null,
      source: typeof file.source === "string" ? file.source : null,
      // Re-normalize against today's menu in case items were added since recording.
      result: normalizeResult(raw, catalog),
    };
  } catch {
    return null;
  }
}

export function writeRecording(rec: Recording, dir = recordedDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = recordingPath(rec.sha256, dir);
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}
