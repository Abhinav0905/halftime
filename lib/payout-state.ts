// Reimbursement payout states shared by the server and the reimbursement pages. No runtime imports,
// so client components can use it.

import type { Reimbursement } from "./repo";

/** payoutStatus while we don't know whether PayPal accepted the current try. */
export const PAYOUT_UNKNOWN = "UNKNOWN";

type PayoutFields = Pick<Reimbursement, "status" | "payoutStatus">;

// Item statuses that no longer move on their own within a game night.
const SETTLED = new Set(["SUCCESS", "UNCLAIMED"]);

/** Approved, but PayPal has not said whether it took the payout. */
export function payoutUnconfirmed(r: PayoutFields): boolean {
  return r.status === "requested" && r.payoutStatus === PAYOUT_UNKNOWN;
}

/** PayPal may still change this payout soon: unconfirmed, or sent and still being processed. */
export function payoutInFlight(r: PayoutFields): boolean {
  return payoutUnconfirmed(r) || (r.status === "sent" && !SETTLED.has(r.payoutStatus ?? ""));
}
