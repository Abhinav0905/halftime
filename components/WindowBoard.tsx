"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientNightState, ClientOrder } from "@/lib/redact";
import type { NightStatus } from "@/lib/repo";
import type { NightEvent } from "@/lib/events";
import { getJson } from "./api";
import { LocalTime } from "./LocalTime";
import { fundingLabel } from "./format";
import { NightStatusPill, cx } from "./ui";

type Conn = "connecting" | "live" | "polling";
interface Decline { key: string; code: string; reason: string }

const FLASH_MS = 4_000;
const DECLINE_MS = 8_000;
const POLL_MS = 5_000;

function handedKey(nightId: string) {
  return `halftime:handed:${nightId}`;
}

export function WindowBoard({
  nightId,
  title,
  initialStatus,
  initialOrders,
}: {
  nightId: string;
  title: string;
  initialStatus: NightStatus;
  initialOrders: ClientOrder[];
}) {
  const [orders, setOrders] = useState(initialOrders);
  const [status, setStatus] = useState(initialStatus);
  const [conn, setConn] = useState<Conn>("connecting");
  const [handed, setHanded] = useState<Set<string>>(() => new Set());
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set());
  const [declines, setDeclines] = useState<Decline[]>([]);
  const [loadError, setLoadError] = useState(false);
  const known = useRef(new Set(initialOrders.filter((o) => o.status === "COMPLETED").map((o) => o.id)));

  // "Handed over" is a per-tablet convenience, so it lives in this browser only.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(handedKey(nightId));
      if (saved) setHanded(new Set(JSON.parse(saved) as string[]));
    } catch {
      // Storage unavailable: start with nothing handed over.
    }
  }, [nightId]);

  function toggleHanded(id: string) {
    setHanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(handedKey(nightId), JSON.stringify([...next]));
      } catch {
        // Not critical.
      }
      return next;
    });
  }

  const flash = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setFlashing((prev) => new Set([...prev, ...ids]));
    setTimeout(() => {
      setFlashing((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, FLASH_MS);
  }, []);

  const reload = useCallback(async () => {
    const res = await getJson<ClientNightState>(`/api/nights/${encodeURIComponent(nightId)}`);
    if (!res.ok) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const fresh = res.data.orders;
    const newlyPaid = fresh.filter((o) => o.status === "COMPLETED" && !known.current.has(o.id)).map((o) => o.id);
    for (const id of newlyPaid) known.current.add(id);
    setOrders(fresh);
    setStatus(res.data.night.status);
    flash(newlyPaid);
  }, [nightId, flash]);

  const addDecline = useCallback((code: string, reason: string) => {
    const key = `${code}-${Date.now()}`;
    setDeclines((prev) => [{ key, code, reason }, ...prev].slice(0, 3));
    setTimeout(() => setDeclines((prev) => prev.filter((d) => d.key !== key)), DECLINE_MS);
  }, []);

  // Live updates over Server-Sent Events, with polling whenever the stream is down.
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let backoff = 2_000;
    let stopped = false;

    const startPolling = () => {
      setConn("polling");
      if (!poll) poll = setInterval(reload, POLL_MS);
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(`/api/nights/${encodeURIComponent(nightId)}/events`);
      source.onopen = () => {
        backoff = 2_000;
        setConn("live");
        if (poll) clearInterval(poll);
        poll = null;
        // Catch anything that happened while disconnected.
        void reload();
      };
      source.onmessage = (msg) => {
        let event: NightEvent | null = null;
        try {
          event = JSON.parse(msg.data as string) as NightEvent;
        } catch {
          return;
        }
        if (event.type === "order.declined") addDecline(event.code, event.reason);
        void reload();
      };
      source.onerror = () => {
        startPolling();
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (poll) clearInterval(poll);
    };
  }, [nightId, reload, addDecline]);

  const paid = orders
    .filter((o) => o.status === "COMPLETED" || o.status === "REFUNDED")
    .sort((a, b) => (b.capturedAt ?? b.createdAt).localeCompare(a.capturedAt ?? a.createdAt));
  const waiting = paid.filter((o) => o.status === "COMPLETED" && !handed.has(o.id));
  const done = paid.filter((o) => !(o.status === "COMPLETED" && !handed.has(o.id)));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <Link href={`/nights/${nightId}`} className="text-sm text-brand hover:underline">← Game page</Link>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Window board · {title}</h1>
        </div>
        <NightStatusPill status={status} />
        <ConnectionBadge conn={conn} error={loadError} />
      </div>

      {status !== "selling" && (
        <div className="mb-4 rounded-lg bg-warn-soft p-3 text-sm font-medium text-warn">
          {status === "setup"
            ? "Not taking orders yet. The menu opens once the opening count is confirmed."
            : "Ordering has closed for this game. Paid orders stay here until they are handed over."}
        </div>
      )}

      <div aria-live="assertive" className="space-y-2">
        {declines.map((d) => (
          <div key={d.key} className="rounded-xl border-2 border-bad bg-bad-soft p-4 text-bad">
            <span className="font-mono text-3xl font-black tracking-widest">{d.code}</span>
            <span className="ml-3 text-lg font-semibold">Payment declined.</span>
            <span className="ml-1 text-base">Nothing to hand over yet; the buyer can try another way to pay.</span>
          </div>
        ))}
      </div>

      <div className="mt-2 mb-3 flex items-baseline gap-4 text-sm text-ink-soft">
        <span><span className="text-2xl font-bold tabular text-ink">{waiting.length}</span> to hand over</span>
        <span><span className="text-lg font-semibold tabular text-ink">{done.length}</span> done or refunded</span>
      </div>

      {paid.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-card p-10 text-center text-ink-soft">
          <p className="text-lg font-semibold text-ink">No paid orders yet</p>
          <p className="mt-1">Paid orders appear here the moment PayPal confirms them.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...waiting, ...done].map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              handed={handed.has(o.id)}
              flashing={flashing.has(o.id)}
              onToggle={() => toggleHanded(o.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionBadge({ conn, error }: { conn: Conn; error: boolean }) {
  const label = error ? "Can't reach the server" : conn === "live" ? "Live" : conn === "polling" ? "Reconnecting, checking every 5 s" : "Connecting…";
  const dot = error ? "bg-bad" : conn === "live" ? "bg-ok" : "bg-warn";
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1 text-sm text-ink-soft" role="status">
      <span className={cx("size-2.5 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
}

function OrderCard({ order, handed, flashing, onToggle }: { order: ClientOrder; handed: boolean; flashing: boolean; onToggle: () => void }) {
  const refunded = order.status === "REFUNDED";
  const muted = handed || refunded;
  const via = fundingLabel(order);
  return (
    <article
      className={cx(
        "flex flex-col rounded-2xl border-2 p-4 shadow-sm transition-colors duration-1000",
        flashing ? "border-ok bg-ok-soft" : "border-line bg-card",
        muted && "opacity-50",
      )}
      aria-label={`Order ${order.code}`}
    >
      <div className="flex items-start gap-2">
        <span className={cx("font-mono text-6xl leading-none font-black tracking-widest text-ink", refunded && "line-through")}>{order.code}</span>
        <span
          className={cx(
            "ml-auto rounded-full px-2.5 py-1 text-xs font-bold",
            via === "Venmo" ? "bg-gold-soft text-ink" : via === "Offline demo" ? "border border-line bg-paper text-ink-soft" : "bg-brand-soft text-brand",
          )}
        >
          {via}
        </span>
      </div>
      <ul className="mt-3 flex-1 space-y-0.5 text-xl text-ink">
        {order.items.map((l) => (
          <li key={l.sku}>
            <span className="font-bold tabular">{l.quantity} ×</span> {l.name}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <LocalTime iso={order.capturedAt ?? order.createdAt} style="time" className="text-sm text-muted" />
        {refunded ? (
          <span className="ml-auto text-sm font-semibold text-ink-soft">Refunded</span>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            className={cx(
              "ml-auto min-h-12 rounded-lg px-4 text-base font-semibold",
              handed ? "border border-line bg-white text-ink-soft" : "bg-ok text-white hover:bg-ok/90",
            )}
          >
            {handed ? "Undo" : "Handed over"}
          </button>
        )}
      </div>
    </article>
  );
}
