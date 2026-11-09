import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@paypal/paypal-server-sdk"],
  poweredByHeader: false,
  agentRules: false,
  experimental: {
    // proxy.ts makes Next buffer every request body in memory (10 MB by default). Photo uploads are the
    // largest body: 8 MB plus 64 KB of multipart wrapping. Next keeps only the first part of a larger body,
    // so the limit sits a little above that and a cut-off upload still reaches the route oversized and gets a 413.
    proxyClientMaxBodySize: 8.5 * 1024 * 1024,
  },
};

export default nextConfig;
