// Collapsed list of everything that happened on a night, newest first.

import type { AuditRow } from "@/lib/repo";
import { LocalTime } from "./LocalTime";

function describe(action: string): string {
  const text = action.replace(/[._]/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function detailText(detail: unknown): string | null {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== "object") return String(detail);
  const parts = Object.entries(detail as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length ? parts.join(" · ").slice(0, 200) : null;
}

export function AuditTrail({ rows }: { rows: AuditRow[] }) {
  return (
    <details className="group rounded-xl border border-line bg-card p-4 shadow-sm sm:p-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold text-ink">
        <span className="transition-transform group-open:rotate-90" aria-hidden>▸</span>
        Audit trail
        <span className="text-sm font-normal text-muted">({rows.length} {rows.length === 1 ? "entry" : "entries"})</span>
      </summary>
      {rows.length ? (
        <ol className="mt-3 divide-y divide-line text-sm">
          {rows.map((r) => {
            const detail = detailText(r.detail);
            return (
              <li key={r.id} className="flex flex-wrap gap-x-3 py-2">
                <LocalTime iso={r.at} className="w-28 shrink-0 text-xs text-muted tabular" />
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-ink">{describe(r.action)}</span>
                  {r.actor && <span className="text-ink-soft"> by {r.actor}</span>}
                  {detail && <div className="break-words text-xs text-muted">{detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-muted">Nothing recorded yet. Every count, payment, refund and approval is logged here.</p>
      )}
    </details>
  );
}
