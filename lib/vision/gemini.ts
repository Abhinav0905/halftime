// One Gemini generateContent call over REST. No SDK: the request is small and
// this keeps the dependency list short for anyone reviewing the code.

import { buildCountPrompt } from "./prompt";
import { normalizeResult, type CatalogRef, type CountResult } from "./schema";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 25_000;

export class VisionError extends Error {}

export interface GeminiCount {
  result: CountResult;
  model: string;
  latencyMs: number;
}

/** OpenAPI-subset schema Gemini uses to constrain its JSON output to CountResult. */
export function countResponseSchema(skus: readonly string[]) {
  return {
    type: "OBJECT",
    properties: {
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            sku: { type: "STRING", enum: [...skus] },
            boxes: {
              type: "ARRAY",
              items: { type: "ARRAY", items: { type: "INTEGER" }, minItems: 4, maxItems: 4 },
            },
            count: { type: "INTEGER" },
            confidence: { type: "STRING", enum: ["high", "medium", "low"] },
          },
          required: ["sku", "boxes", "count", "confidence"],
          // Boxes before count: the model enumerates units, then totals them.
          propertyOrdering: ["sku", "boxes", "count", "confidence"],
        },
      },
      unknown: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { label: { type: "STRING" }, count: { type: "INTEGER" } },
          required: ["label", "count"],
          propertyOrdering: ["label", "count"],
        },
      },
      quality: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["items", "unknown", "quality"],
    propertyOrdering: ["items", "unknown", "quality"],
  };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export async function countWithGemini(input: {
  bytes: Buffer;
  mime: string;
  catalog: readonly CatalogRef[];
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): Promise<GeminiCount> {
  const { bytes, mime, catalog, apiKey, model } = input;
  if (!apiKey) throw new VisionError("No Gemini API key is configured.");

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mime, data: bytes.toString("base64") } },
          { text: buildCountPrompt(catalog) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: countResponseSchema(catalog.map((c) => c.sku)),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? TIMEOUT_MS);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new VisionError(controller.signal.aborted ? "Gemini did not answer within the time limit." : `Could not reach Gemini: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  let payload: GeminiResponse;
  try {
    payload = (await res.json()) as GeminiResponse;
  } catch {
    throw new VisionError(`Gemini returned HTTP ${res.status} with a body that is not JSON.`);
  }
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    throw new VisionError(`Gemini returned HTTP ${res.status}: ${payload.error?.status ?? ""} ${payload.error?.message ?? ""}`.trim());
  }
  if (payload.promptFeedback?.blockReason) {
    throw new VisionError(`Gemini declined the photo (${payload.promptFeedback.blockReason}).`);
  }
  const candidate = payload.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  if (!text) throw new VisionError(`Gemini returned no answer (finish reason ${candidate?.finishReason ?? "unknown"}).`);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VisionError(`Gemini's answer was not valid JSON (finish reason ${candidate?.finishReason ?? "unknown"}).`);
  }

  let result: CountResult;
  try {
    result = normalizeResult(raw, catalog);
  } catch (err) {
    throw new VisionError((err as Error).message);
  }

  return { result, model, latencyMs };
}
