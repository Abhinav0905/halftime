"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { OrderRow, Person } from "@/lib/repo";
import { formatCents } from "@/lib/money";
import { postJson } from "./api";
import { LocalTime } from "./LocalTime";
import { PersonSelect } from "./PersonSelect";
import { ORDER_STATUS_LABEL, fundingLabel, itemsSummary } from "./format";
import { Pill, buttonClass, cx, type Tone } from "./ui";

const PAGE = 10;

const STATUS_TONE: Record<string, Tone> = { COMPLETED: "ok", REFUNDED: "neutral", DECLINED: "bad", CREATED: "neutral" };

export function OrderList({
  orders,
  people,
  canRefund,
}: {
  orders: OrderRow[];
  people: Person[];
  canRefund: boolean;
}) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [by, setBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newestFirst = [...orders].reverse();
  const settled = newestFirst.filter((o) => o.status === "COMPLETED" || o.status === "REFUNDED");
  const other = newestFirst.length - settled.length;
  const filtered = showAll ? newestFirst : settled;
  const shown = expanded ? filtered : filtered.slice(0, PAGE);

  async function refund(order: OrderRow) {
    if (!by) {
      setError("Choose who is giving the refund.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await postJson<{ status: string; refundId: string }>(`/api/orders/${encodeURIComponent(order.id)}/refund`, { by });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRefunding(null);
    router.refresh();
  }

  if (!orders.length) {
    return <p className="text-sm text-muted">No orders yet. They appear here as fans pay at the booth QR code.</p>;
  }

  return (
    <div>
      <ul className="divide-y divide-line">
        {shown.map((o) => (
          <li key={o.id} className={cx("py-3", o.status !== "COMPLETED" && "text-ink-soft")}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-lg font-bold tracking-wider text-ink">{o.code}</span>
              <Pill tone={STATUS_TONE[o.status] ?? "neutral"}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Pill>
              {o.status !== "CREATED" && <span className="text-xs text-muted">{fundingLabel(o)}</span>}
              <span className="ml-auto text-base font-semibold tabular text-ink">{formatCents(o.totalCents)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm">
              <span className="min-w-0 flex-1">{itemsSummary(o.items)}</span>
              <LocalTime iso={o.capturedAt ?? o.createdAt} style="time" className="text-xs text-muted" />
            </div>
            {o.status === "DECLINED" && o.declineReason && (
              <div className="mt-1 text-xs text-bad">Payment declined ({o.declineReason}). The buyer was asked to try another way to pay.</div>
            )}
            {canRefund && o.status === "COMPLETED" && refunding !== o.id && (
              <button
                type="button"
                className="mt-2 text-sm font-medium text-bad hover:underline"
                onClick={() => {
                  setRefunding(o.id);
                  setError(null);
                }}
              >
                Refund this order
              </button>
            )}
            {refunding === o.id && (
              <div className="mt-3 rounded-lg border border-bad/30 bg-bad-soft p-3">
                <p className="text-sm text-ink">
                  Refund <strong>{formatCents(o.totalCents)}</strong> to the buyer for order <strong>{o.code}</strong>? The items leave the PayPal column straight away.
                </p>
                <div className="mt-2 max-w-xs">
                  <PersonSelect label="Who is giving the refund" people={people} value={by} onChange={setBy} />
                </div>
                {error && <p role="alert" className="mt-2 text-sm font-medium text-bad">{error}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={buttonClass("danger")} disabled={busy} onClick={() => refund(o)}>
                    {busy ? "Refunding…" : `Refund ${formatCents(o.totalCents)}`}
                  </button>
                  <button type="button" className={buttonClass("secondary")} disabled={busy} onClick={() => setRefunding(null)}>
                    Keep the order
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!shown.length && <p className="py-3 text-sm text-muted">No paid orders yet.</p>}
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {filtered.length > PAGE && (
          <button type="button" className="text-sm font-medium text-brand hover:underline" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show the newest 10" : `Show all ${filtered.length}`}
          </button>
        )}
        {other > 0 && (
          <button type="button" className="text-sm font-medium text-brand hover:underline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show paid and refunded only" : `Also show ${other} unpaid or declined`}
          </button>
        )}
      </div>
    </div>
  );
}
