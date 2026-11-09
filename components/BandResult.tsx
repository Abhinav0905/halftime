// Expected vs actual, with a green/amber/red band and a plain explanation.

import type { Band } from "@/lib/engine/reconcile";
import { formatCents } from "@/lib/money";
import { Variance, cx } from "./ui";

const FRAME: Record<Band, string> = {
  green: "border-ok/40 bg-ok-soft",
  amber: "border-warn/40 bg-warn-soft",
  red: "border-bad/40 bg-bad-soft",
};

const HEADLINE: Record<Band, string> = {
  green: "Matches",
  amber: "Small difference",
  red: "Difference to review",
};

function explain(kind: "cash" | "deposit", band: Band, variance: number, tolerance: number, finalized: boolean): string {
  const amount = formatCents(Math.abs(variance));
  const allowance = formatCents(tolerance);
  if (kind === "cash") {
    if (band === "green") {
      return variance === 0
        ? "The cash in the box is exactly what the counts and PayPal say it should be."
        : `The box is within the ${allowance} allowance for making change.`;
    }
    const dir = variance < 0 ? "short" : "over";
    const notice = finalized ? "Differences like this go to the officers as a notice" : "When the night is finalized the officers get a notice";
    if (band === "amber") {
      return `The box is ${dir} by ${amount}, more than the ${allowance} allowance. ${notice} so someone can take a second look. Change given wrong or an item missed in a count are the usual causes.`;
    }
    return `The box is ${dir} by ${amount}. ${notice} to compare the count sheet, the photos and the PayPal orders. This only shows where the numbers differ, not why.`;
  }
  if (band === "green") return "The deposit matches the counted cash minus the float. Nothing else to do.";
  const dir = variance < 0 ? "lower" : "higher";
  return `The deposit is ${amount} ${dir} than the counted cash minus the float. The officers have a notice to compare the bank slip with the count sheet.`;
}

export function BandResult({
  kind,
  expectedLabel,
  actualLabel,
  expectedCents,
  actualCents,
  varianceCents,
  band,
  toleranceCents,
  finalized = false,
}: {
  kind: "cash" | "deposit";
  expectedLabel: string;
  actualLabel: string;
  expectedCents: number;
  actualCents: number;
  varianceCents: number;
  band: Band;
  toleranceCents: number;
  finalized?: boolean;
}) {
  return (
    <div className={cx("rounded-xl border p-4 sm:p-5", FRAME[band])}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-ink">{band === "green" && varianceCents !== 0 ? "Within the allowance" : HEADLINE[band]}</h3>
        <Variance cents={varianceCents} band={band} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-ink-soft">{expectedLabel}</div>
          <div className="text-3xl font-bold tabular text-ink">{formatCents(expectedCents)}</div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-ink-soft">{actualLabel}</div>
          <div className="text-3xl font-bold tabular text-ink">{formatCents(actualCents)}</div>
        </div>
      </div>
      <p className="mt-3 text-sm text-ink">{explain(kind, band, varianceCents, toleranceCents, finalized)}</p>
    </div>
  );
}
