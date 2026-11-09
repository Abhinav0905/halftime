// Helpers for route handlers: consistent JSON responses and zod-validated bodies.

import { NextResponse } from "next/server";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Every JSON body the app sends is a few hundred bytes; this leaves plenty of room. */
export const MAX_JSON_BYTES = 64 * 1024;

/**
 * Read the whole body, stopping with a 413 as soon as it passes `max` bytes.
 * Counting while streaming matters: a chunked upload has no Content-Length.
 */
export async function readBody(req: Request, max: number, tooLarge = "The request is too large."): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(req.headers.get("content-length")) > max) throw new HttpError(413, tooLarge);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, tooLarge);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes = MAX_JSON_BYTES): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await readBody(req, maxBytes)));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Expected a JSON body.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(400, first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request.");
  }
  return parsed.data;
}

/** Wrap a handler so HttpError becomes a JSON error and anything else a logged 500. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.message, err.status);
      console.error(err);
      return fail("Something went wrong on the server. Please try again.", 500);
    }
  };
}
