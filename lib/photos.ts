// Photo storage. Files are named by their SHA-256, so the same photo is stored
// once and a stored count can always be traced back to the exact image.

import fs from "node:fs";
import path from "node:path";
import { photoDir } from "./config";
import { HttpError } from "./http";
import { getPhoto, insertPhoto } from "./repo";
import { SHA256_RE, sha256Hex } from "./sha256";

export { SHA256_RE };

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type PhotoMime = keyof typeof PHOTO_TYPES;

/** The type the bytes actually are, from their magic numbers. The upload's own label is not trusted. */
export function sniffImageType(buf: Buffer): PhotoMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function savePhoto(buffer: Buffer, declaredMime: string): { sha256: string; mime: PhotoMime; bytes: number } {
  if (buffer.length === 0) throw new HttpError(400, "The photo is empty.");
  if (buffer.length > MAX_PHOTO_BYTES) throw new HttpError(413, "The photo is larger than 8 MB.");
  // Some browsers send an empty or generic type; the bytes decide in that case.
  if (declaredMime.startsWith("image/") && !(declaredMime in PHOTO_TYPES)) {
    throw new HttpError(415, "Photos must be JPEG, PNG or WebP.");
  }
  const mime = sniffImageType(buffer);
  if (!mime) throw new HttpError(415, "That file does not look like a JPEG, PNG or WebP photo.");

  const sha256 = sha256Hex(buffer);
  const dir = photoDir();
  const file = path.join(dir, `${sha256}.${PHOTO_TYPES[mime]}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    // Write then rename so a half-written file is never served under its final name.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
  }
  insertPhoto({ sha256, path: file, mime, bytes: buffer.length });
  return { sha256, mime, bytes: buffer.length };
}

export function readPhoto(sha256: string): { bytes: Buffer; mime: string } | null {
  if (!SHA256_RE.test(sha256)) return null;
  const row = getPhoto(sha256);
  if (!row) return null;
  try {
    return { bytes: fs.readFileSync(path.resolve(row.path)), mime: row.mime };
  } catch {
    return null;
  }
}

export function photoUrl(sha256: string): string {
  return `/api/photos/${sha256}`;
}
