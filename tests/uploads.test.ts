import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as uploadPhoto } from "@/app/api/nights/[id]/photos/route";
import { POST as suggest } from "@/app/api/nights/[id]/suggest/route";
import { resetDbForTests } from "@/lib/db";
import { HttpError, MAX_JSON_BYTES, readBody, readJson } from "@/lib/http";
import { MAX_PHOTO_BYTES, savePhoto } from "@/lib/photos";
import { createNight } from "@/lib/repo";
import { seedDemo } from "@/lib/seed";
import { writeRecording } from "@/lib/vision/replay";

/** A request body that arrives in chunks with no Content-Length, like a chunked upload. */
function chunked(total: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
}

function streamRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/api", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

async function status(p: Promise<unknown>): Promise<number | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
}

describe("body size caps", () => {
  it("cuts off a chunked body as soon as it passes the limit", async () => {
    let pulled = 0;
    const source = chunked(10 * 1024 * 1024);
    const counted = source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(c, ctrl) {
          pulled += c.byteLength;
          ctrl.enqueue(c);
        },
      }),
    );
    expect(await status(readBody(streamRequest(counted), 256 * 1024))).toBe(413);
    // It stopped reading near the limit instead of buffering all 10 MB.
    expect(pulled).toBeLessThan(1024 * 1024);
  });

  it("rejects a declared Content-Length over the limit without reading", async () => {
    const req = new Request("http://test.local/api", { method: "POST", body: "{}", headers: { "content-length": String(MAX_JSON_BYTES + 1) } });
    expect(await status(readJson(req, z.object({})))).toBe(413);
  });

  it("caps JSON bodies but still reads normal ones", async () => {
    const schema = z.object({ kind: z.string() });
    const big = JSON.stringify({ kind: "x".repeat(MAX_JSON_BYTES) });
    expect(await status(readJson(streamRequest(new Blob([big]).stream()), schema))).toBe(413);
    expect(await readJson(new Request("http://test.local/api", { method: "POST", body: '{"kind":"open"}' }), schema)).toEqual({ kind: "open" });
    expect(await status(readJson(new Request("http://test.local/api", { method: "POST", body: "not json" }), schema))).toBe(400);
    expect(await status(readJson(new Request("http://test.local/api", { method: "POST" }), schema))).toBe(400);
  });
});

// A few bytes with JPEG magic numbers; the server only sniffs the header.
const jpeg = (tag: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, tag]);

describe("routes", () => {
  const env = { ...process.env };
  let dir: string;
  let nightId: string;
  const ctx = () => ({ params: Promise.resolve({ id: nightId }) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-uploads-"));
    process.env.HALFTIME_DB = path.join(dir, "test.db");
    process.env.HALFTIME_PHOTOS = path.join(dir, "photos");
    process.env.HALFTIME_RECORDED = path.join(dir, "recorded");
    delete process.env.VISION_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    resetDbForTests();
    seedDemo(true);
    nightId = createNight({ title: "vs. Northridge", date: "2026-11-14", floatCents: 10_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetDbForTests();
    process.env = { ...env };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("photo upload", () => {
    it("stores a photo sent as multipart form data", async () => {
      const form = new FormData();
      form.append("purpose", "open");
      form.append("file", new Blob([jpeg(1)], { type: "image/jpeg" }), "photo.jpg");
      const res = await uploadPhoto(new Request("http://test.local/api", { method: "POST", body: form }), ctx());
      expect(res.status).toBe(201);
      const body = (await res.json()) as { sha256: string; url: string };
      expect(body.url).toBe(`/api/photos/${body.sha256}`);
    });

    it("stops an oversized chunked upload at the 8 MB limit", async () => {
      const req = streamRequest(chunked(MAX_PHOTO_BYTES + 512 * 1024), { "content-type": "multipart/form-data; boundary=x" });
      const res = await uploadPhoto(req, ctx());
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "The photo is larger than 8 MB." });
    });

    it("answers 400 to a body that is not a photo upload", async () => {
      const res = await uploadPhoto(new Request("http://test.local/api", { method: "POST", body: "hello" }), ctx());
      expect(res.status).toBe(400);
    });
  });

  describe("suggest", () => {
    const post = (sha256: string) =>
      suggest(new Request("http://test.local/api", { method: "POST", body: JSON.stringify({ kind: "open", sha256 }) }), ctx());

    it("reuses the stored suggestion for the same photo instead of calling the model again", async () => {
      process.env.GEMINI_API_KEY = "test-key";
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{ sku: "water", count: 2, confidence: "high", boxes: [[0, 0, 9, 9], [10, 10, 19, 19]] }], unknown: [], quality: [] }) }] } }],
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { sha256 } = savePhoto(Buffer.from(jpeg(2)), "image/jpeg");

      const first = (await (await post(sha256)).json()) as { suggestionId: string; provider: string; result: { items: { sku: string; count: number }[] } };
      const second = (await (await post(sha256)).json()) as typeof first;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.provider).toBe("gemini");
      expect(second.suggestionId).toBe(first.suggestionId);
      expect(second.provider).toBe("gemini");
      expect(second.result.items.find((i) => i.sku === "water")?.count).toBe(2);
    });

    it("replays a recording with no API key, and says so when it is reused", async () => {
      const { sha256 } = savePhoto(Buffer.from(jpeg(3)), "image/jpeg");
      writeRecording(
        { sha256, model: "gemini-test", recordedAt: null, source: "public/demo/open.jpg", result: { items: [{ sku: "chips", count: 5, confidence: "high", boxes: [] }], unknown: [], quality: [] } },
        process.env.HALFTIME_RECORDED,
      );
      const first = (await (await post(sha256)).json()) as { suggestionId: string; provider: string; model: string };
      expect(first).toMatchObject({ provider: "replay", model: "gemini-test" });
      const second = (await (await post(sha256)).json()) as typeof first;
      expect(second).toMatchObject({ suggestionId: first.suggestionId, provider: "replay", model: "gemini-test" });
    });

    it("asks for a hand count when there is no key and no recording", async () => {
      const { sha256 } = savePhoto(Buffer.from(jpeg(4)), "image/jpeg");
      const body = (await (await post(sha256)).json()) as { result: unknown; message: string };
      expect(body.result).toBeNull();
      expect(body.message).toMatch(/Count by hand/);
    });
  });
});
