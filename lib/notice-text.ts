// Wording for the notices officers read. Each notice says what happened, the
// numbers behind it, and what to do next. Never an accusation.

import { formatCents } from "./money";
import { agreeingCounts, type CashCount, type ReconcileResult } from "./engine/reconcile";
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

/** The two people whose matching counts settled the cash total. */
function agreeingCounters(counts: CashCount[]): string[] {
  const pair = agreeingCounts(counts);
  return pair ? pair.map((c) => c.countedBy) : [];
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
  const counted = formatCents(recon.cash.countedCents);
  const float = formatCents(night.floatCents);
  const opening = `${depositor} recorded a bank deposit of ${formatCents(recon.depositCents)} for ${gameName(night)}. `;
  if (recon.cash.countedCents < night.floatCents) {
    // Counted − float would be negative; "the deposit should be −$50.00" helps nobody.
    return {
      level: recon.depositBand,
      title: `Deposit of ${formatCents(recon.depositCents)} recorded when no deposit was expected`,
      body:
        opening +
        `Two volunteers counted ${counted} in the box, which is less than the ${float} float, ` +
        `so nothing was left to deposit after keeping back the float. Please compare the deposit slip with the count sheet.`,
    };
  }
  return {
    level: recon.depositBand,
    title: v < 0 ? `Deposit is ${amount} lower than the counted cash` : `Deposit is ${amount} higher than the counted cash`,
    body:
      opening +
      `Two volunteers counted ${counted} in the box, so after keeping back the ` +
      `${float} float the deposit should be ${formatCents(recon.depositExpectedCents)}. ` +
      `Please compare the deposit slip with the count sheet.`,
  };
}

/** Where the counted cash now stands against the expected box, in one sentence. */
function cashStanding(recon: ReconcileResult): string {
  const v = recon.cashVarianceCents;
  if (v === null || recon.cash.countedCents === null) return "";
  const counted = formatCents(recon.cash.countedCents);
  if (v === 0) return ` The ${counted} counted in the box now matches exactly.`;
  return ` The ${counted} counted in the box is now ${formatCents(Math.abs(v))} ${v < 0 ? "short of" : "over"} that.`;
}

/**
 * A full refund recorded after the night was finalized. Its items move from the PayPal
 * column to the cash column, so the expected cash changes. Pass the night's numbers from
 * just before and just after the refund so the notice can say by how much.
 */
export function lateRefundNotice(
  night: Night,
  order: OrderRow,
  change?: { before: ReconcileResult; after: ReconcileResult },
): NoticeDraft {
  const intro =
    `Order ${order.code} (${formatCents(order.totalCents)}) from ${gameName(night)} was refunded in PayPal after the night was closed. ` +
    `Its items now count as cash sales instead of PayPal sales. `;
  const closing = ` If the items came back to the stand or this was a duplicate charge, please add a note to the count sheet.`;

  let effect: string;
  let level: NoticeDraft["level"] = "amber";
  if (!change) {
    effect = "That changes the expected cash for the night; the game page shows the updated numbers.";
  } else {
    const { before, after } = change;
    if (after.cashBand === "red") level = "red";
    if (after.expectedBoxCents === null) {
      effect = !after.counted
        ? "The expected cash will include them once both stock counts are saved."
        : "Some items still need a recount, so the expected cash for the night still can't be worked out.";
    } else if (before.expectedBoxCents === null) {
      effect =
        `Before the refund the expected cash couldn't be worked out because PayPal showed more sold than the counts did. ` +
        `With the refund it can: ${formatCents(after.expectedBoxCents)} should have been in the box, including the ${formatCents(night.floatCents)} float.` +
        cashStanding(after);
    } else {
      const up = after.expectedBoxCents - before.expectedBoxCents;
      effect =
        `The expected cash in the box went from ${formatCents(before.expectedBoxCents)} to ${formatCents(after.expectedBoxCents)}` +
        (up > 0 ? `, up ${formatCents(up)}.` : ".") +
        cashStanding(after);
    }
  }
  return { level, title: `PayPal order ${order.code} was refunded after close-out`, body: intro + effect + closing };
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

/** A PayPal payment that completed after the stand stopped selling (for example a pending capture that cleared later). */
export function lateCaptureNotice(night: Night, order: OrderRow): NoticeDraft {
  return {
    level: "amber",
    title: `PayPal order ${order.code} completed after selling ended`,
    body:
      `Order ${order.code} (${formatCents(order.totalCents)}) from ${gameName(night)} was confirmed by PayPal after the stand stopped taking orders. ` +
      `Its items now count as PayPal sales instead of cash, so the expected cash for that night went down by up to ${formatCents(order.totalCents)}. ` +
      `Please check whether these items were handed over before the closing count.`,
  };
}
