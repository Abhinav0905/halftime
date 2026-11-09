// Display formatting shared by server and client components.

/** "2026-10-24" -> "Sat, Oct 24". Game dates are calendar dates, so format them in UTC to avoid a day shift. */
export function formatGameDate(date: string, opts: { year?: boolean } = {}): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(opts.year ? { year: "numeric" } : {}),
  });
}

export function todayLocalIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function itemsSummary(items: { name: string; quantity: number }[]): string {
  if (!items.length) return "No items";
  return items.map((i) => `${i.quantity} × ${i.name}`).join(", ");
}

export function fundingLabel(o: { id: string; funding: string | null; simulated: boolean }): string {
  // Orders taken without PayPal credentials get a SIM- id (see the API contract).
  if (o.simulated && o.id.startsWith("SIM-")) return "Offline demo";
  const f = (o.funding ?? "").toLowerCase();
  if (f === "venmo") return "Venmo";
  if (f === "paypal") return "PayPal";
  if (f) return f.charAt(0).toUpperCase() + f.slice(1);
  return o.simulated ? "Offline demo" : "PayPal";
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  CREATED: "Not paid",
  COMPLETED: "Paid",
  DECLINED: "Declined",
  REFUNDED: "Refunded",
};

export const PAYOUT_TONE: Record<string, "ok" | "warn" | "bad"> = {
  SUCCESS: "ok",
  PENDING: "warn",
  PROCESSING: "warn",
  UNCLAIMED: "warn",
  ONHOLD: "warn",
  FAILED: "bad",
  RETURNED: "bad",
  BLOCKED: "bad",
  REFUNDED: "bad",
  REVERSED: "bad",
  DENIED: "bad",
};
