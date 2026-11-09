import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/http";
import {
  STAFF_COOKIE, STAFF_COOKIE_MAX_AGE, clearPinFailures, hasStaffCookie, pinAttemptAllowed, pinMatches, recordPinFailure,
  safeNextPath, staffPin, staffToken,
} from "@/lib/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SignIn = z.object({ pin: z.string().max(200), next: z.string().max(2000).optional() });

function isHttps(req: NextRequest): boolean {
  // Behind Render's load balancer the app sees plain http; the original scheme is in x-forwarded-proto.
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded ? forwarded === "https" : req.nextUrl.protocol === "https:";
}

function setStaffCookie(res: NextResponse, req: NextRequest, value: string, maxAge: number): void {
  res.cookies.set(STAFF_COOKIE, value, { httpOnly: true, sameSite: "lax", secure: isHttps(req), path: "/", maxAge });
}

/** The last x-forwarded-for hop is the one the platform's proxy added, so a client can't pick its own key. */
function clientKey(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
}

/** Lets the header decide whether to show "Sign out". */
export const GET = handle(async (req: NextRequest) => {
  const pin = staffPin();
  return ok({ pinRequired: pin !== null, signedIn: await hasStaffCookie(req.cookies.get(STAFF_COOKIE)?.value, pin) });
});

export const POST = handle(async (req: NextRequest) => {
  const body = await readJson(req, SignIn);
  const next = safeNextPath(body.next);
  const pin = staffPin();
  if (!pin) return ok({ ok: true, pinRequired: false, next });

  const client = clientKey(req);
  if (!pinAttemptAllowed(client)) throw new HttpError(429, "Too many tries. Wait 15 minutes, then try again.");
  if (!(await pinMatches(body.pin, pin))) {
    recordPinFailure(client);
    throw new HttpError(401, "That PIN doesn't match. Check it with the club treasurer.");
  }
  clearPinFailures(client);
  const res = ok({ ok: true, pinRequired: true, next });
  setStaffCookie(res, req, await staffToken(pin), STAFF_COOKIE_MAX_AGE);
  return res;
});

export const DELETE = handle(async (req: NextRequest) => {
  const res = ok({ ok: true });
  setStaffCookie(res, req, "", 0);
  return res;
});
