// Wording for the notices officers read. Each notice says what happened, the
// numbers behind it, and what to do next. Never an accusation.

import { formatCents } from "./money";
import { samePerson, type CashCount, type ReconcileResult } from "./engine/reconcile";
import type { Night, Notice, OrderRow } from "./repo";

export interface NoticeDraft {
  level: Notice["level"];
  title: string;
  body: string;
}

/** "the vs. Northridge game on Oct 24" */
export function gameName(night: Pick<Night, "title" | "date">): string {
  const d = new Date(`${night.date}T12:00:00Z`);
  const day = Number.isNaN(d.getTime()) ? night.date : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `the ${night.title} game on ${day}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The two counts that settled the cash total: the latest, and the latest one before it by someone else. */
function agreeingCounters(counts: CashCount[]): string[] {
  const last = counts[counts.length - 1];
  if (!last) return [];
  const prev = [...counts].reverse().find((c) => !samePerson(c.countedBy, last.countedBy));
  return prev ? [prev.countedBy, last.countedBy] : [last.countedBy];
}

export function cashVarianceNotice(night: Night, recon: ReconcileResult, closedBy: string): NoticeDraft | null {
  const v = recon.cashVarianceCents;
  if (v === null || v === 0 || recon.cashBand === null || recon.cashBand === "green") return null;
  if (recon.expectedBoxCents === null || recon.expectedCashSalesCents === null || recon.cash.countedCents === null) return null;
  const counters = joinNames(agreeingCounters(recon.cash.counts));
  const amount = formatCents(Math.abs(v));
  return {
    level: recon.cashBand,
    title: v < 0 ? `Cash box is ${amount} short of expected` : `Cash box is ${amount} over expected`,
    body:
      `Two volunteers (${counters}) counted ${formatCents(recon.cash.countedCents)} after ${gameName(night)}. ` +
      `Items sold minus items paid through PayPal come to ${formatCents(recon.expectedCashSalesCents)} in cash sales, ` +
      `so ${formatCents(recon.expectedBoxCents)} should have been in the box, including the ${formatCents(night.floatCents)} float. ` +
      `${closedBy} closed the night. Please recount the box and check the count sheet before the deposit is made.`,
  };
}

export function recountNoteNotice(night: Night, recon: ReconcileResult, closedBy: string, note: string): NoticeDraft {
  const flagged = recon.lines.filter((l) => l.recount);
  const details = flagged.map((l) => `${l.name}: ${l.recountReason ?? "counts do not add up"}`).join(" ");
  return {
    level: "amber",
    title: "Night closed with a recount note",
    body:
      `${closedBy} closed ${gameName(night)} while ${flagged.length === 1 ? "one item still needed" : `${flagged.length} items still needed`} a recount. ` +
      `${details} Until the counts agree with PayPal, the expected cash for this night cannot be worked out. ` +
      `Note from ${closedBy}: "${note.trim()}" Please compare the count photos with the count sheet.`,
  };
}

export function depositVarianceNotice(night: Night, recon: ReconcileResult, depositor: string): NoticeDraft | null {
  const v = recon.depositVarianceCents;
  if (v === null || v === 0 || recon.depositBand === null || recon.depositBand === "green") return null;
  if (recon.depositCents === null || recon.depositExpectedCents === null || recon.cash.countedCents === null) return null;
  const amount = formatCents(Math.abs(v));
  return {
    level: recon.depositBand,
    title: v < 0 ? `Deposit is ${amount} lower than the counted cash` : `Deposit is ${amount} higher than the counted cash`,
    body:
      `${depositor} recorded a bank deposit of ${formatCents(recon.depositCents)} for ${gameName(night)}. ` +
      `Two volunteers counted ${formatCents(recon.cash.countedCents)} in the box, so after keeping back the ` +
      `${formatCents(night.floatCents)} float the deposit should be ${formatCents(recon.depositExpectedCents)}. ` +
      `Please compare the deposit slip with the count sheet.`,
  };
}

export function lateRefundNotice(night: Night, order: OrderRow): NoticeDraft {
  return {
    level: "amber",
    title: `PayPal order ${order.code} was refunded after close-out`,
    body:
      `Order ${order.code} (${formatCents(order.totalCents)}) from ${gameName(night)} was refunded in PayPal after the night was closed. ` +
      `Its items now count as cash sales, so the expected cash for that night went up by ${formatCents(order.totalCents)}. ` +
      `If the items came back to the stand or this was a duplicate charge, please add a note to the count sheet.`,
  };
}

export function partialRefundNotice(night: Night, order: OrderRow, refundCents: number): NoticeDraft {
  return {
    level: "amber",
    title: `PayPal order ${order.code} was partly refunded`,
    body:
      `PayPal refunded ${formatCents(refundCents)} of order ${order.code} (${formatCents(order.totalCents)}) from ${gameName(night)}. ` +
      `Halftime only tracks full refunds, so the order's items still count as PayPal sales. ` +
      `Please note the partial refund on the count sheet.`,
  };
}
