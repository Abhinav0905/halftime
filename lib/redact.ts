// What the browser may fetch about a night. Staff pages render on the server
// from the full NightState; anything served as JSON goes through here.
//
// The cash count is blind: while the night is closing and two people's counts
// don't agree yet, nothing a client can fetch may give away a counted total or
// the expected cash. The closing count is withheld too, because opening −
// closing − waste − PayPal units would rebuild the expected cash per item.

import type { CashStatus, Counts, ReconcileResult } from "./engine/reconcile";
import type { CashCountRow, CountRecord, DepositRow, NightState, NightStatus, OrderRow, Person, Reimbursement } from "./repo";

export function isCashBlind(status: NightStatus, cashStatus: CashStatus): boolean {
  return status === "closing" && cashStatus !== "agree";
}

/** An order without the buyer's email or the capture id. */
export type ClientOrder = Omit<OrderRow, "payer" | "captureId"> & { payer: null; captureId: null };

export interface ClientNightState extends Omit<NightState, "close" | "cashCounts" | "orders" | "people" | "reimbursements" | "deposit"> {
  /** True while the cash count is blind; the fields that would reveal the expected cash are null. */
  cashHidden: boolean;
  close: (Omit<CountRecord, "counts" | "waste"> & { counts: Counts | null; waste: Counts | null }) | null;
  cashCounts: (Omit<CashCountRow, "cents"> & { cents: number | null })[];
  orders: ClientOrder[];
  people: (Omit<Person, "email"> & { email: null })[];
  reimbursements: (Omit<Reimbursement, "payeeEmail" | "receiptSha256"> & { payeeEmail: null; receiptSha256: null })[];
  deposit: (Omit<DepositRow, "slipSha256"> & { slipSha256: null }) | null;
}

export function redactOrder(o: OrderRow): ClientOrder {
  return { ...o, payer: null, captureId: null };
}

export function redactRecon(r: ReconcileResult): ReconcileResult {
  return {
    ...r,
    lines: r.lines.map((l) => ({ ...l, close: null, sold: null, cashUnits: null, cashCents: null })),
    soldUnits: null,
    cashUnits: null,
    expectedCashSalesCents: null,
    expectedBoxCents: null,
    totalSalesCents: null,
    cash: { ...r.cash, countedCents: null, counts: [] },
    cashVarianceCents: null,
    cashBand: null,
    depositExpectedCents: null,
    depositVarianceCents: null,
    depositBand: null,
  };
}

export function redactNightState(state: NightState): ClientNightState {
  const cashHidden = isCashBlind(state.night.status, state.recon.cash.status);
  // Emails, capture ids and photo hashes stay on the server; the staff pages that need them render there.
  const shared = {
    cashHidden,
    orders: state.orders.map(redactOrder),
    people: state.people.map((p) => ({ ...p, email: null })),
    reimbursements: state.reimbursements.map((r) => ({ ...r, payeeEmail: null, receiptSha256: null })),
    deposit: state.deposit && { ...state.deposit, slipSha256: null },
  };
  if (!cashHidden) return { ...state, ...shared };
  return {
    ...state,
    ...shared,
    close: state.close && { ...state.close, counts: null, waste: null },
    cashCounts: state.cashCounts.map((c) => ({ ...c, cents: null })),
    recon: redactRecon(state.recon),
  };
}
