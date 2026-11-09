// The four steps of a game night, with what is done and who did it.

import type { NightState } from "@/lib/repo";
import { formatCents } from "@/lib/money";
import { cx } from "./ui";

type StepState = "done" | "current" | "upcoming";

interface Step {
  title: string;
  state: StepState;
  detail: string;
}

const ORDER = ["setup", "selling", "closing", "closed", "deposited"] as const;

function stepsFor(s: NightState): Step[] {
  const at = ORDER.indexOf(s.night.status);
  const state = (doneFrom: number, currentAt: number[]): StepState =>
    at >= doneFrom ? "done" : currentAt.includes(at) ? "current" : "upcoming";

  const counters = s.cashCounts.map((c) => c.countedBy);
  const uniqueCounters = [...new Set(counters)];

  return [
    {
      title: "Opening count",
      state: s.open ? "done" : "current",
      detail: s.open ? `${s.open.countedBy}, checked by ${s.open.checkedBy}` : "Photograph the stocked table",
    },
    {
      title: "Selling",
      state: state(2, [1]),
      detail:
        s.recon.paypalOrders > 0
          ? `${s.recon.paypalOrders} PayPal ${s.recon.paypalOrders === 1 ? "order" : "orders"}, ${formatCents(s.recon.paypalCents)}`
          : at >= 1
            ? "No PayPal orders yet"
            : "Opens after the opening count",
    },
    {
      title: "Closing count & cash",
      state: state(3, [2]),
      detail: s.close
        ? uniqueCounters.length
          ? `Leftovers: ${s.close.countedBy}. Cash: ${uniqueCounters.join(" and ")}`
          : `Leftovers counted by ${s.close.countedBy}`
        : "Photograph the leftovers, then count the box",
    },
    {
      title: "Deposit",
      state: state(4, [3]),
      detail: s.deposit ? `${s.deposit.depositor}, ${formatCents(s.deposit.cents)}` : "Next day, by someone who did not count",
    },
  ];
}

export function NightProgress({ state }: { state: NightState }) {
  const steps = stepsFor(state);
  return (
    <ol className="grid gap-2 sm:grid-cols-4" aria-label="Progress for this game">
      {steps.map((step, i) => (
        <li
          key={step.title}
          className={cx(
            "flex gap-3 rounded-lg border p-3 sm:flex-col sm:gap-1.5",
            step.state === "done" && "border-ok/30 bg-ok-soft",
            step.state === "current" && "border-brand bg-brand-soft ring-1 ring-brand",
            step.state === "upcoming" && "border-line bg-white",
          )}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span
            className={cx(
              "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold",
              step.state === "done" && "bg-ok text-white",
              step.state === "current" && "bg-brand text-white",
              step.state === "upcoming" && "bg-paper text-muted border border-line",
            )}
            aria-hidden
          >
            {step.state === "done" ? "✓" : i + 1}
          </span>
          <div className="min-w-0">
            <div className={cx("text-sm font-semibold", step.state === "upcoming" ? "text-muted" : "text-ink")}>
              {step.title}
              <span className="sr-only">
                {step.state === "done" ? " (done)" : step.state === "current" ? " (in progress)" : " (not started)"}
              </span>
            </div>
            <div className="text-xs text-ink-soft">{step.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
