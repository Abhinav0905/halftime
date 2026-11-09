"use client";

import { useState } from "react";
import { Pill, cx, type Tone } from "@/components/ui";
import type { Counts } from "@/lib/engine/reconcile";
import type { Confidence } from "@/lib/vision/schema";

const MAX = 9999;

export interface EditorItem {
  sku: string;
  name: string;
}

/**
 * Per item PayPal sold: the opening count minus PayPal's units, i.e. the most
 * that can be left before waste. Items PayPal didn't sell have no entry.
 */
export type LeftoverCaps = Record<string, number>;

const CONFIDENCE: Record<Confidence, { label: string; tone: Tone }> = {
  high: { label: "high confidence", tone: "ok" },
  medium: { label: "medium confidence", tone: "warn" },
  low: { label: "low confidence", tone: "bad" },
};

/** Leftovers that PayPal's itemized sales make impossible. Says nothing until an entry is over the cap. */
export function recountWarnings(items: EditorItem[], counts: Counts, waste: Counts | null, caps: LeftoverCaps | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!caps) return out;
  for (const item of items) {
    const cap = caps[item.sku];
    if (cap === undefined) continue;
    const w = waste?.[item.sku] ?? 0;
    const maxLeft = cap - w;
    const left = counts[item.sku] ?? 0;
    if (left <= maxLeft) continue;
    if (maxLeft >= 0) {
      out[item.sku] = `PayPal's sales show no more than ${maxLeft} can be left. Please recount.`;
    } else if (cap >= 0) {
      out[item.sku] = "The waste entered is more than PayPal's sales leave room for. Check the waste entry.";
    } else {
      out[item.sku] = "PayPal recorded more sold than the opening count. The opening count may be off; the close-out will flag it for a recount.";
    }
  }
  return out;
}

function clamp(n: number): number {
  return Math.min(MAX, Math.max(0, Math.trunc(n)));
}

function Stepper({ value, onChange, label, size = "lg" }: { value: number; onChange: (n: number) => void; label: string; size?: "lg" | "md" }) {
  const btn = cx(
    "flex shrink-0 items-center justify-center rounded-lg border border-line bg-white font-bold text-ink active:bg-paper disabled:text-muted",
    size === "lg" ? "h-12 w-12 text-2xl" : "h-11 w-11 text-xl",
  );
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={btn} onClick={() => onChange(clamp(value - 1))} disabled={value <= 0} aria-label={`One fewer ${label}`}>
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={label}
        value={String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          onChange(clamp(digits === "" ? 0 : Number(digits)));
        }}
        className={cx(
          "rounded-lg border border-line bg-white text-center font-bold text-ink tabular focus:border-brand focus:outline-none",
          size === "lg" ? "h-12 w-20 text-xl" : "h-11 w-16 text-lg",
        )}
      />
      <button type="button" className={btn} onClick={() => onChange(clamp(value + 1))} disabled={value >= MAX} aria-label={`One more ${label}`}>
        +
      </button>
    </div>
  );
}

export function CountEditor({
  items,
  counts,
  onCountsChange,
  suggested = null,
  confidence = null,
  colors = {},
  waste = null,
  onWasteChange,
  caps = null,
  onSelect,
}: {
  items: EditorItem[];
  counts: Counts;
  onCountsChange: (next: Counts) => void;
  /** The photo count, when there is one. Edits against it are marked "changed". */
  suggested?: Counts | null;
  confidence?: Record<string, Confidence> | null;
  colors?: Record<string, string>;
  /** Pass a waste map (closing count) to show a waste row for each item. */
  waste?: Counts | null;
  onWasteChange?: (next: Counts) => void;
  /** Closing count only: see LeftoverCaps. */
  caps?: LeftoverCaps | null;
  /** Tapping an item name, e.g. to show its boxes on the photo. */
  onSelect?: (sku: string) => void;
}) {
  const [wasteOpen, setWasteOpen] = useState<Record<string, boolean>>({});
  const warnings = recountWarnings(items, counts, waste, caps);

  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-card">
      {items.map((item) => {
        const value = counts[item.sku] ?? 0;
        const sug = suggested ? suggested[item.sku] : undefined;
        const changed = sug !== undefined && sug !== value;
        const conf = confidence?.[item.sku];
        const w = waste?.[item.sku] ?? 0;
        const showWaste = waste !== null && (w > 0 || wasteOpen[item.sku]);
        return (
          <li key={item.sku} className={cx("p-3 sm:p-4", warnings[item.sku] && "bg-warn-soft/60")}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onSelect?.(item.sku)}
                  className={cx("flex items-center gap-2 text-left text-base font-semibold text-ink", !onSelect && "cursor-default")}
                >
                  {colors[item.sku] && <span className="h-3.5 w-3.5 shrink-0 rounded-sm" style={{ backgroundColor: colors[item.sku] }} />}
                  {item.name}
                </button>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                  {sug !== undefined && (
                    <span>
                      Photo count <span className="font-semibold text-ink-soft tabular">{sug}</span>
                    </span>
                  )}
                  {sug !== undefined && conf && <Pill tone={CONFIDENCE[conf].tone}>{CONFIDENCE[conf].label}</Pill>}
                  {changed && <Pill tone="info">changed</Pill>}
                </div>
              </div>
              <Stepper value={value} label={item.name} onChange={(n) => onCountsChange({ ...counts, [item.sku]: n })} />
            </div>

            {waste !== null && onWasteChange && (
              <div className="mt-2">
                {showWaste ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-paper p-2">
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium text-ink">Waste</div>
                      <div className="text-muted">Dropped, expired or given away</div>
                    </div>
                    <Stepper size="md" value={w} label={`${item.name} waste`} onChange={(n) => onWasteChange({ ...waste, [item.sku]: n })} />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setWasteOpen((s) => ({ ...s, [item.sku]: true }))}
                    className="min-h-11 text-sm font-medium text-brand hover:underline"
                  >
                    + Add waste
                  </button>
                )}
              </div>
            )}

            {warnings[item.sku] && <p className="mt-2 text-sm font-medium text-warn">{warnings[item.sku]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
