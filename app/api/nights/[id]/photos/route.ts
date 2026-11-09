import { HttpError, handle, ok, readBody } from "@/lib/http";
import { MAX_PHOTO_BYTES, photoUrl, savePhoto } from "@/lib/photos";
import { audit, getNight } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PURPOSES = new Set(["open", "close", "slip", "receipt"]);
const MULTIPART_MARGIN = 64 * 1024;
const TOO_LARGE = "The photo is larger than 8 MB.";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!getNight(id)) throw new HttpError(404, "That game night was not found.");

  // Count bytes as they arrive so an oversized or chunked upload is cut off at
  // the limit instead of being buffered whole. The margin covers the multipart wrapping.
  let form: FormData;
  try {
    const body = await readBody(req, MAX_PHOTO_BYTES + MULTIPART_MARGIN, TOO_LARGE);
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Expected a photo upload (multipart form data).");
  }

  const purpose = form.get("purpose");
  if (typeof purpose !== "string" || !PURPOSES.has(purpose)) {
    throw new HttpError(400, "purpose must be open, close, slip or receipt.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Attach the photo as the file field.");
  if (file.size > MAX_PHOTO_BYTES) throw new HttpError(413, TOO_LARGE);

  const saved = savePhoto(Buffer.from(await file.arrayBuffer()), file.type);
  audit(id, null, "photo.uploaded", { purpose, sha256: saved.sha256, mime: saved.mime, bytes: saved.bytes });
  return ok({ sha256: saved.sha256, url: photoUrl(saved.sha256) }, 201);
});
