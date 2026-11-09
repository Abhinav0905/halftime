// All money in Halftime is integer cents. These helpers are the only place
// that converts between cents, PayPal's decimal strings and what people type.

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

/** Signed variance, e.g. "+$2.00", "−$27.00", "$0.00". */
export function formatVariance(cents: number): string {
  if (cents === 0) return "$0.00";
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

/** 700 -> "7.00" (PayPal amount value). */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "7.00" -> 700. Strict: PayPal always sends two decimals for USD. */
export function valueToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid amount value: ${value}`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "0").padEnd(2, "0"));
  return whole * 100 + frac;
}

/** What a volunteer types: "52", "52.5", "$52.50", "1,052.00". Returns null if unreadable. */
export function parseDollarInput(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
}
