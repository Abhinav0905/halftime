import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@paypal/paypal-server-sdk"],
  poweredByHeader: false,
  agentRules: false,
};

export default nextConfig;
