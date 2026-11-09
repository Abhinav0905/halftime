// Optional staff PIN. When STAFF_PIN is set, proxy.ts keeps everything except
// the buyer menu and payment routes behind one shared PIN. It is a demo-grade
// gate for a booth tablet, not user accounts (see SECURITY.md).
//
// Web Crypto only, so the same code runs in proxy.ts, route handlers and tests.

export const STAFF_COOKIE = "halftime_staff";
export const STAFF_ONLY_MESSAGE = "Staff only. Enter the club's staff PIN first.";
/** How long a signed-in device stays signed in. Changing STAFF_PIN signs every device out. */
export const STAFF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

// The cookie holds an HMAC of this label keyed by the PIN, so it proves the PIN
// was entered without storing the PIN itself in the browser.
const TOKEN_LABEL = "halftime-staff-v1";
const encoder = new TextEncoder();

export function staffPin(): string | null {
  const pin = process.env.STAFF_PIN?.trim();
  return pin ? pin : null;
}

let warnedOpen = false;

/** Logs once per server process that the app is running without a PIN. */
export function warnIfNoPin(): void {
  if (warnedOpen) return;
  warnedOpen = true;
  console.warn("STAFF_PIN is not set, so every page and API route is open to anyone who can reach this server. Set it before sharing the URL.");
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function staffToken(pin: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(TOKEN_LABEL)));
}

/** String comparison whose running time depends only on the lengths, not on where the strings differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Compares digests rather than the raw strings, so the timing doesn't reveal the PIN's length either. */
export async function pinMatches(entered: string, pin: string): Promise<boolean> {
  const digest = async (v: string) => toHex(await crypto.subtle.digest("SHA-256", encoder.encode(v.trim())));
  return safeEqual(await digest(entered), await digest(pin));
}

/** True when no PIN is configured, or the cookie carries the token for the current PIN. */
export async function hasStaffCookie(cookieValue: string | undefined, pin: string | null = staffPin()): Promise<boolean> {
  if (!pin) return true;
  if (!cookieValue) return false;
  return safeEqual(cookieValue, await staffToken(pin));
}

// Routes a fan's phone needs without the PIN: the menu, paying, checking an
// order's status, PayPal's webhook, and the files that render those pages.
const PUBLIC_ROUTES: { methods: string[] | null; pattern: RegExp }[] = [
  { methods: null, pattern: /^\/m\/.+$/ },
  { methods: null, pattern: /^\/how-it-works$/ },
  { methods: null, pattern: /^\/staff$/ },
  { methods: null, pattern: /^\/api\/staff$/ },
  { methods: ["GET", "HEAD"], pattern: /^\/api\/health$/ },
  { methods: ["POST"], pattern: /^\/api\/orders$/ },
  { methods: ["POST"], pattern: /^\/api\/orders\/[^/]+\/capture$/ },
  { methods: ["GET", "HEAD"], pattern: /^\/api\/orders\/[^/]+$/ },
  { methods: ["POST"], pattern: /^\/api\/paypal\/webhook$/ },
];

// Image files from public/ and app icons. Page data and API responses never end in these.
const STATIC_FILE = /\.(?:ico|png|jpe?g|gif|svg|webp|avif|webmanifest)$/i;

export function isPublicRequest(method: string, pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  // Next's own scripts and styles. /_next/image stays gated: it can fetch /api/photos on the caller's behalf.
  if (path.startsWith("/_next/") && !path.startsWith("/_next/image")) return true;
  if (!path.startsWith("/api/") && STATIC_FILE.test(path)) return true;
  const m = method.toUpperCase();
  return PUBLIC_ROUTES.some((r) => r.pattern.test(path) && (r.methods === null || r.methods.includes(m)));
}

/** Where to go after signing in. Only same-origin paths, so the sign-in page can't be used to bounce people elsewhere. */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f\\]/.test(next)) return "/";
  if (next === "/staff" || next.startsWith("/staff?") || next.startsWith("/api/")) return "/";
  return next;
}

// Failed PIN attempts per client, so a short PIN can't be guessed by trying every value.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

export function pinAttemptAllowed(client: string, now = Date.now()): boolean {
  const f = failures.get(client);
  return !f || f.resetAt <= now || f.count < MAX_FAILURES;
}

export function recordPinFailure(client: string, now = Date.now()): void {
  if (failures.size > 5_000) {
    for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
  }
  const f = failures.get(client);
  if (!f || f.resetAt <= now) failures.set(client, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  else f.count += 1;
}

export function clearPinFailures(client: string): void {
  failures.delete(client);
}
