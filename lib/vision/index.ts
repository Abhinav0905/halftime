// Entry point for suggested counts. The suggestion only pre-fills the count
// screen; a volunteer confirms every number, so any failure here falls back
// to counting by hand instead of blocking the night.

import { visionConfig, type VisionProvider } from "../config";
import { countWithGemini } from "./gemini";
import { findRecording } from "./replay";
import type { CatalogRef, CountResult } from "./schema";

export type { CountResult, CatalogRef } from "./schema";

export interface Suggestion {
  provider: VisionProvider;
  model: string | null;
  result: CountResult | null;
  message?: string;
  latencyMs?: number;
}

export const MESSAGES = {
  failed: "The photo count did not work this time. Count by hand; the photo is still saved.",
  noRecording: "Photo counting is not set up on this copy of Halftime, and there is no recorded count for this photo. Count by hand; the photo is still saved.",
  manual: "Photo counting is turned off. Count by hand; the photo is still saved.",
  recordedFallback: "The live photo count did not answer, so this is the recorded count for this photo. Check it against the table.",
} as const;

export async function suggestCounts(input: {
  sha256: string;
  bytes: Buffer;
  mime: string;
  catalog: readonly CatalogRef[];
}): Promise<Suggestion> {
  const cfg = visionConfig();

  if (cfg.provider === "manual") {
    return { provider: "manual", model: null, result: null, message: MESSAGES.manual };
  }

  if (cfg.provider === "replay") {
    const started = Date.now();
    const rec = findRecording(input.sha256, input.catalog);
    if (!rec) return { provider: "manual", model: null, result: null, message: MESSAGES.noRecording };
    return { provider: "replay", model: rec.model, result: rec.result, latencyMs: Date.now() - started };
  }

  try {
    const out = await countWithGemini({ bytes: input.bytes, mime: input.mime, catalog: input.catalog, apiKey: cfg.apiKey, model: cfg.model });
    return { provider: "gemini", model: out.model, result: out.result, latencyMs: out.latencyMs };
  } catch (err) {
    // Log the reason for whoever runs the server; the volunteer gets the plain message.
    console.warn(`[vision] ${cfg.model}: ${(err as Error).message}`);
    const rec = findRecording(input.sha256, input.catalog);
    if (rec) return { provider: "replay", model: rec.model, result: rec.result, message: MESSAGES.recordedFallback };
    return { provider: "gemini", model: cfg.model, result: null, message: MESSAGES.failed };
  }
}
