import { HttpError, handle, ok } from "@/lib/http";
import { MAX_PHOTO_BYTES, photoUrl, savePhoto } from "@/lib/photos";
import { audit, getNight } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PURPOSES = new Set(["open", "close", "slip", "receipt"]);

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!getNight(id)) throw new HttpError(404, "That game night was not found.");

  // Reject oversized uploads before buffering the whole body.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_PHOTO_BYTES + 64 * 1024) throw new HttpError(413, "The photo is larger than 8 MB.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Expected a photo upload (multipart form data).");
  }

  const purpose = form.get("purpose");
  if (typeof purpose !== "string" || !PURPOSES.has(purpose)) {
    throw new HttpError(400, "purpose must be open, close, slip or receipt.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Attach the photo as the file field.");
  if (file.size > MAX_PHOTO_BYTES) throw new HttpError(413, "The photo is larger than 8 MB.");

  const saved = savePhoto(Buffer.from(await file.arrayBuffer()), file.type);
  audit(id, null, "photo.uploaded", { purpose, sha256: saved.sha256, mime: saved.mime, bytes: saved.bytes });
  return ok({ sha256: saved.sha256, url: photoUrl(saved.sha256) }, 201);
});
