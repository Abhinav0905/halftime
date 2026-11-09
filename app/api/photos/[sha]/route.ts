import { HttpError, handle } from "@/lib/http";
import { SHA256_RE, readPhoto } from "@/lib/photos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ sha: string }> }) => {
  const { sha } = await ctx.params;
  const sha256 = sha.toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new HttpError(400, "A photo id is 64 hexadecimal characters.");

  const etag = `"${sha256}"`;
  const cache = {
    // The URL is the content hash, so the bytes behind it never change.
    "cache-control": "public, max-age=31536000, immutable",
    etag,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: cache });

  const photo = readPhoto(sha256);
  if (!photo) throw new HttpError(404, "Photo not found.");
  return new Response(new Uint8Array(photo.bytes), {
    status: 200,
    headers: {
      ...cache,
      "content-type": photo.mime,
      "content-length": String(photo.bytes.length),
      "x-content-type-options": "nosniff",
    },
  });
});
