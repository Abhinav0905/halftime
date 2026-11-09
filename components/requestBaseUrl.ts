import { headers } from "next/headers";
import { publicBaseUrl } from "@/lib/config";

/** Base URL the booth QR code should point at: PUBLIC_BASE_URL, else the host this page was requested on. */
export async function requestBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0]!.trim();
  return publicBaseUrl(host, proto);
}
