// Entry point for suggested counts. The suggestion only pre-fills the count
// screen; a volunteer confirms every number, so any failure here falls back
// to counting by hand instead of blocking the night.

import { visionConfig, type VisionProvider } from "../config";
import { countWithGemini } from "./gemini";
import { createRateLimiter } from "./limit";
import { MESSAGES } from "./messages";
import { findRecording } from "./replay";
import type { CatalogRef, CountResult } from "./schema";

export type { CountResult, CatalogRef } from "./schema";
export { MESSAGES } from "./messages";

export interface Suggestion {
  provider: VisionProvider;
  model: string | null;
  result: CountResult | null;
  message?: string;
  latencyMs?: number;
}

/** A game night needs two counts; this leaves room for plenty of retakes. */
export const MODEL_CALLS_PER_HOUR = 12;
/** Across all games, so creating new games can't get around the per-game limit. */
export const MODEL_CALLS_PER_HOUR_ALL_GAMES = 60;
const HOUR_MS = 60 * 60 * 1000;
const perNight = createRateLimiter({ max: MODEL_CALLS_PER_HOUR, windowMs: HOUR_MS });
const allNights = createRateLimiter({ max: MODEL_CALLS_PER_HOUR_ALL_GAMES, windowMs: HOUR_MS });
const ALL = "all";

/** Takes one model call from both limits, or neither. */
function takeModelCall(nightId: string): boolean {
  if (!perNight.allows(nightId) || !allNights.allows(ALL)) return false;
  perNight.take(nightId);
  allNights.take(ALL);
  return true;
}

export function resetModelCallLimitsForTests(): void {
  perNight.reset();
  allNights.reset();
}

export async function suggestCounts(input: {
  nightId: string;
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

  if (!takeModelCall(input.nightId)) {
    const rec = findRecording(input.sha256, input.catalog);
    if (rec) return { provider: "replay", model: rec.model, result: rec.result };
    return { provider: "gemini", model: cfg.model, result: null, message: MESSAGES.busy };
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
