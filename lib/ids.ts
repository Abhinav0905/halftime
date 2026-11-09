import crypto from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("base64url")}`;
}

// Pickup codes are read aloud across a counter: no 0/O, 1/I/L, 5/S, 2/Z.
const LETTERS = "ABCDEFGHJKMNPQRTUVWXY";
const DIGITS = "346789";

export function pickupCode(): string {
  const r = crypto.randomBytes(3);
  return `${LETTERS[r[0]! % LETTERS.length]}${DIGITS[r[1]! % DIGITS.length]}${LETTERS[r[2]! % LETTERS.length]}`;
}
