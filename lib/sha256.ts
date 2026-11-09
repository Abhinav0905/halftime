// Photos and their recorded counts are keyed by SHA-256. Kept free of other
// imports so the eval and demo scripts can use it without loading the database.

import crypto from "node:crypto";

export const SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
