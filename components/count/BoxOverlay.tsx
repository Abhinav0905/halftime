"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import type { Box } from "@/lib/vision/schema";

// Saturated colors that stay visible on a busy photo of a table.
const PALETTE = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#ea580c", "#db2777", "#4d7c0f", "#475569"];

/** One stable color per item, in menu order, shared by the overlay and the count editor. */
export function skuColors(skus: readonly string[]): Record<string, string> {
  return Object.fromEntries(skus.map((sku, i) => [sku, PALETTE[i % PALETTE.length]!]));
}

export interface OverlayItem {
  sku: string;
  name: string;
  color: string;
  boxes: Box[];
}

function pct(v: number): string {
  return `${v / 10}%`;
}

export function BoxOverlay({
  src,
  items,
  alt = "Photo of the table with a numbered box on each counted item",
  highlight: controlled,
  onHighlight,
}: {
  src: string;
  items: OverlayItem[];
  alt?: string;
  highlight?: string | null;
  onHighlight?: (sku: string | null) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const highlight = controlled !== undefined ? controlled : own;
  const select = (sku: string | null) => {
    setOwn(sku);
    onHighlight?.(sku);
  };

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-line bg-paper">
        {broken ? (
          <div className="p-6 text-center text-sm text-muted">The photo could not be loaded. The counts below still work.</div>
        ) : (
          <>
            <img src={src} alt={alt} className="block h-auto w-full select-none" draggable={false} onError={() => setBroken(true)} />
            {/* Boxes are positioned in percent of the 0–1000 grid, so they follow the image at any rendered size. */}
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              {items.flatMap((item) =>
                item.boxes.map(([ymin, xmin, ymax, xmax], i) => {
                  const dim = highlight !== null && highlight !== item.sku;
                  const on = highlight === item.sku;
                  return (
                    <div
                      key={`${item.sku}-${i}`}
                      className={cx("absolute rounded-sm transition-opacity", dim ? "opacity-15" : "opacity-100")}
                      style={{
                        top: pct(ymin),
                        left: pct(xmin),
                        height: pct(ymax - ymin),
                        width: pct(xmax - xmin),
                        border: `${on ? 3 : 2}px solid ${item.color}`,
                        backgroundColor: on ? `${item.color}26` : "transparent",
                      }}
                    >
                      <span
                        className="absolute left-0 top-0 min-w-4 rounded-br-sm px-0.5 text-center text-[10px] font-bold leading-4 text-white tabular"
                        style={{ backgroundColor: item.color }}
                      >
                        {i + 1}
                      </span>
                    </div>
                  );
                }),
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Show the boxes for one item">
        {items.map((item) => {
          const on = highlight === item.sku;
          return (
            <button
              key={item.sku}
              type="button"
              aria-pressed={on}
              onClick={() => select(on ? null : item.sku)}
              className={cx(
                "inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm font-medium",
                on ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:bg-paper",
              )}
            >
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
              {item.name}
              <span className={cx("tabular", on ? "text-white/80" : "text-muted")}>{item.boxes.length}</span>
            </button>
          );
        })}
        {highlight !== null && (
          <button type="button" onClick={() => select(null)} className="min-h-11 px-3 text-sm font-medium text-brand hover:underline">
            Show all
          </button>
        )}
      </div>
    </div>
  );
}
