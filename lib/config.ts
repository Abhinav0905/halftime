// Environment access. Read lazily so `next build` never bakes secrets in.

export type VisionProvider = "gemini" | "replay" | "manual";

export function paypalConfig() {
  return {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
    // Halftime only runs against the PayPal sandbox.
    apiBase: "https://api-m.sandbox.paypal.com",
  };
}

export function paypalConfigured(): boolean {
  const c = paypalConfig();
  return Boolean(c.clientId && c.clientSecret);
}

export function visionConfig(): { provider: VisionProvider; apiKey: string; model: string } {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const requested = (process.env.VISION_PROVIDER ?? "").toLowerCase();
  let provider: VisionProvider = apiKey ? "gemini" : "replay";
  if (requested === "replay" || requested === "manual") provider = requested;
  if (requested === "gemini" && !apiKey) provider = "replay";
  return { provider, apiKey, model: process.env.GEMINI_MODEL || "gemini-3.5-flash" };
}

export function dbPath(): string {
  return process.env.HALFTIME_DB || "./data/halftime.db";
}

export function photoDir(): string {
  return process.env.HALFTIME_PHOTOS || "./data/photos";
}

export function publicBaseUrl(fallbackHost?: string | null, proto = "http"): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (fallbackHost) return `${proto}://${fallbackHost}`;
  return "http://localhost:3000";
}
