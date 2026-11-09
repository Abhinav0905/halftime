import { paypalConfigured, visionConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, paypal: paypalConfigured() ? "sandbox" : "offline-demo", photoCount: visionConfig().provider });
}
