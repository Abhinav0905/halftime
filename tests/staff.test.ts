import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../proxy";
import {
  STAFF_COOKIE, STAFF_ONLY_MESSAGE, hasStaffCookie, isPublicRequest, pinAttemptAllowed, pinMatches, recordPinFailure, safeEqual,
  safeNextPath, staffToken,
} from "../lib/staff";
import { DELETE as staffDelete, GET as staffGet, POST as staffPost } from "../app/api/staff/route";
import { POST as demoReset } from "../app/api/demo/reset/route";
import { resetDbForTests } from "../lib/db";
import { createNight, listNights } from "../lib/repo";
import { seedDemo } from "../lib/seed";

const PIN = "4821-tigers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("public allowlist", () => {
  it("lets a fan's phone order, pay and check status", () => {
    expect(isPublicRequest("GET", "/m/night_abc")).toBe(true);
    expect(isPublicRequest("POST", "/api/orders")).toBe(true);
    expect(isPublicRequest("POST", "/api/orders/5O190127TN364715T/capture")).toBe(true);
    expect(isPublicRequest("GET", "/api/orders/5O190127TN364715T")).toBe(true);
    expect(isPublicRequest("POST", "/api/paypal/webhook")).toBe(true);
    expect(isPublicRequest("GET", "/api/health")).toBe(true);
    expect(isPublicRequest("GET", "/how-it-works")).toBe(true);
    expect(isPublicRequest("GET", "/how-it-works/")).toBe(true);
    expect(isPublicRequest("GET", "/staff")).toBe(true);
    expect(isPublicRequest("POST", "/api/staff")).toBe(true);
  });

  it("lets Next's scripts and image files through", () => {
    expect(isPublicRequest("GET", "/_next/static/chunks/app.js")).toBe(true);
    expect(isPublicRequest("GET", "/favicon.ico")).toBe(true);
    expect(isPublicRequest("GET", "/icon.png")).toBe(true);
  });

  it("keeps staff routes behind the PIN", () => {
    expect(isPublicRequest("GET", "/")).toBe(false);
    expect(isPublicRequest("GET", "/ledger")).toBe(false);
    expect(isPublicRequest("GET", "/nights/night_abc")).toBe(false);
    expect(isPublicRequest("GET", "/nights/night_abc/close")).toBe(false);
    expect(isPublicRequest("GET", "/api/nights/night_abc")).toBe(false);
    expect(isPublicRequest("GET", "/api/nights/night_abc/events")).toBe(false);
    expect(isPublicRequest("POST", "/api/orders/5O190127TN364715T/refund")).toBe(false);
    expect(isPublicRequest("POST", "/api/reimbursements/r1/approve")).toBe(false);
    expect(isPublicRequest("POST", "/api/demo/reset")).toBe(false);
    expect(isPublicRequest("GET", "/api/photos/abc.png")).toBe(false);
    expect(isPublicRequest("GET", "/_next/image")).toBe(false);
  });

  it("only allows each public API route with the method a fan uses", () => {
    expect(isPublicRequest("GET", "/api/orders")).toBe(false);
    expect(isPublicRequest("POST", "/api/orders/5O190127TN364715T")).toBe(false);
    expect(isPublicRequest("GET", "/api/orders/5O190127TN364715T/capture")).toBe(false);
    expect(isPublicRequest("GET", "/api/paypal/webhook")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/nights/night_abc/close?x=1")).toBe("/nights/night_abc/close?x=1");
  });

  it("refuses anything that could leave the site or loop", () => {
    for (const bad of [undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", "nights", "/staff", "/staff?next=/", "/api/nights/x"]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });
});

describe("PIN and cookie", () => {
  it("derives a stable token that depends on the PIN", async () => {
    const a = await staffToken(PIN);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await staffToken(PIN)).toBe(a);
    expect(await staffToken("other")).not.toBe(a);
    expect(a).not.toContain(PIN);
  });

  it("accepts only the current PIN's token", async () => {
    expect(await hasStaffCookie(await staffToken(PIN), PIN)).toBe(true);
    expect(await hasStaffCookie(await staffToken("old-pin"), PIN)).toBe(false);
    expect(await hasStaffCookie(undefined, PIN)).toBe(false);
    expect(await hasStaffCookie(undefined, null)).toBe(true);
  });

  it("compares PINs and strings exactly", async () => {
    expect(await pinMatches(PIN, PIN)).toBe(true);
    expect(await pinMatches(` ${PIN} `, PIN)).toBe(true);
    expect(await pinMatches("4821", PIN)).toBe(false);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("pauses sign-in after 10 wrong PINs, then allows it again", () => {
    const t = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(pinAttemptAllowed("10.0.0.9", t)).toBe(true);
      recordPinFailure("10.0.0.9", t);
    }
    expect(pinAttemptAllowed("10.0.0.9", t)).toBe(false);
    expect(pinAttemptAllowed("10.0.0.10", t)).toBe(true);
    expect(pinAttemptAllowed("10.0.0.9", t + 15 * 60_000)).toBe(true);
  });
});

describe("proxy", () => {
  const req = (url: string, init: { method?: string; cookie?: string } = {}) =>
    new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", headers: init.cookie ? { cookie: init.cookie } : {} });

  it("leaves everything open and warns once when no PIN is set", async () => {
    vi.stubEnv("STAFF_PIN", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await proxy(req("/api/nights/night_abc"));
    await proxy(req("/ledger"));
    expect(a.headers.get("x-middleware-next")).toBe("1");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("sends a signed-out page visit to /staff and comes back afterwards", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    const res = await proxy(req("/nights/night_abc/close?tab=cash"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/staff");
    expect(to.searchParams.get("next")).toBe("/nights/night_abc/close?tab=cash");
  });

  it("answers a signed-out API call with 401 JSON", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    for (const [url, method] of [["/api/nights/night_abc", "GET"], ["/api/orders/5O190127TN364715T/refund", "POST"], ["/api/demo/reset", "POST"]] as const) {
      const res = await proxy(req(url, { method }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: STAFF_ONLY_MESSAGE });
    }
  });

  it("lets the buyer flow through without a cookie", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    expect((await proxy(req("/m/night_abc"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(req("/api/orders", { method: "POST" }))).headers.get("x-middleware-next")).toBe("1");
  });

  it("lets a signed-in device through, and not one holding an old PIN's cookie", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    const good = await proxy(req("/api/nights/night_abc", { cookie: `${STAFF_COOKIE}=${await staffToken(PIN)}` }));
    expect(good.headers.get("x-middleware-next")).toBe("1");
    const stale = await proxy(req("/api/nights/night_abc", { cookie: `${STAFF_COOKIE}=${await staffToken("old-pin")}` }));
    expect(stale.status).toBe(401);
  });
});

describe("/api/staff", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    staffPost(
      new NextRequest("http://localhost/api/staff", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );

  it("signs in with the right PIN and sets an HttpOnly, SameSite=Lax cookie", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    const res = await post({ pin: PIN, next: "/ledger" }, { "x-forwarded-for": "203.0.113.1", "x-forwarded-proto": "https" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, next: "/ledger" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${STAFF_COOKIE}=${await staffToken(PIN)}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Secure/i);
  });

  it("leaves Secure off on plain http so local sign-in still works", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    const res = await post({ pin: PIN }, { "x-forwarded-for": "203.0.113.2" });
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/Secure/i);
  });

  it("refuses a wrong PIN without setting a cookie, and ignores an off-site next", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    const res = await post({ pin: "0000" }, { "x-forwarded-for": "203.0.113.3" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const ok = await post({ pin: PIN, next: "//evil.example" }, { "x-forwarded-for": "203.0.113.3" });
    expect((await ok.json()).next).toBe("/");
  });

  it("returns 429 after too many wrong PINs from one address", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    for (let i = 0; i < 10; i++) await post({ pin: "0000" }, { "x-forwarded-for": "203.0.113.4" });
    expect((await post({ pin: PIN }, { "x-forwarded-for": "203.0.113.4" })).status).toBe(429);
  });

  it("reports whether a PIN is required and whether this device is signed in", async () => {
    vi.stubEnv("STAFF_PIN", PIN);
    const signedOut = await staffGet(new NextRequest("http://localhost/api/staff"));
    expect(await signedOut.json()).toEqual({ pinRequired: true, signedIn: false });
    const signedIn = await staffGet(new NextRequest("http://localhost/api/staff", { headers: { cookie: `${STAFF_COOKIE}=${await staffToken(PIN)}` } }));
    expect(await signedIn.json()).toEqual({ pinRequired: true, signedIn: true });
    vi.stubEnv("STAFF_PIN", "");
    expect(await (await staffGet(new NextRequest("http://localhost/api/staff"))).json()).toEqual({ pinRequired: false, signedIn: true });
  });

  it("signs out by expiring the cookie", async () => {
    const res = await staffDelete(new NextRequest("http://localhost/api/staff", { method: "DELETE" }));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${STAFF_COOKIE}=`);
    expect(cookie).toMatch(/Max-Age=0/i);
  });
});

describe("POST /api/demo/reset", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "halftime-reset-"));
    vi.stubEnv("HALFTIME_DB", path.join(dir, "test.db"));
    resetDbForTests();
    seedDemo(true);
    createNight({ title: "Reset test game", date: "2026-11-14", floatCents: 10_000 });
  });

  afterEach(() => {
    resetDbForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const reset = (body: string | undefined, headers: Record<string, string> = { "content-type": "application/json" }) =>
    demoReset(new Request("http://localhost:3000/api/demo/reset", { method: "POST", headers: { host: "localhost:3000", ...headers }, body }));
  const created = () => listNights().some((n) => n.title === "Reset test game");

  it("resets with a same-site JSON confirmation", async () => {
    const res = await reset(JSON.stringify({ confirm: "reset" }), { "content-type": "application/json", origin: "http://localhost:3000" });
    expect(res.status).toBe(200);
    expect(created()).toBe(false);
  });

  it("ignores a bare POST, a form post, a missing confirmation and another site's request", async () => {
    expect((await reset(undefined, {})).status).toBe(415);
    expect((await reset('{"confirm":"reset"}', { "content-type": "text/plain" })).status).toBe(415);
    expect((await reset("{}")).status).toBe(400);
    const crossSite = await reset(JSON.stringify({ confirm: "reset" }), { "content-type": "application/json", origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(created()).toBe(true);
  });

  it("stays off when DEMO_RESET_ENABLED is false", async () => {
    vi.stubEnv("DEMO_RESET_ENABLED", "false");
    expect((await reset(JSON.stringify({ confirm: "reset" }))).status).toBe(403);
    expect(created()).toBe(true);
  });
});
