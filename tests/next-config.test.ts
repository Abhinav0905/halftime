import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { MAX_PHOTO_BYTES } from "../lib/photos";

describe("next.config", () => {
  it("keeps the proxy's body buffer just above the photo upload limit", () => {
    const limit = Number(nextConfig.experimental?.proxyClientMaxBodySize);
    // The photo route accepts 8 MB plus 64 KB of multipart wrapping. Next drops the chunk that crosses the limit
    // (up to 64 KB), so a cut-off oversized upload must still be larger than what the route accepts.
    expect(limit - 64 * 1024).toBeGreaterThan(MAX_PHOTO_BYTES + 64 * 1024);
    expect(limit).toBeLessThan(10 * 1024 * 1024);
    expect(nextConfig.agentRules).toBe(false);
  });
});
