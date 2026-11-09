// Staff gate. With STAFF_PIN unset (local development, judges running the repo)
// everything stays open. With it set, only the buyer menu, payment routes and
// PayPal's webhook are public; every other page and API route needs the
// cookie that /staff sets after the PIN is entered.

import { NextResponse, type NextRequest } from "next/server";
import { STAFF_COOKIE, STAFF_ONLY_MESSAGE, hasStaffCookie, isPublicRequest, staffPin, warnIfNoPin } from "@/lib/staff";

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const pin = staffPin();
  if (!pin) {
    warnIfNoPin();
    return NextResponse.next();
  }
  const { pathname, search } = req.nextUrl;
  if (isPublicRequest(req.method, pathname)) return NextResponse.next();
  if (await hasStaffCookie(req.cookies.get(STAFF_COOKIE)?.value, pin)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: STAFF_ONLY_MESSAGE }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const signIn = new URL("/staff", req.url);
  signIn.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(signIn);
}

export const config = {
  // Built scripts and styles skip the proxy entirely; everything else is checked above.
  matcher: ["/((?!_next/static/).*)"],
};
