"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Re-renders the current server page when something happens on this night
 * (an order is paid, a count is saved). Falls back to a slow refresh when the
 * event stream is unavailable.
 */
export function LiveRefresh({ nightId, label = true }: { nightId: string; label?: boolean }) {
  const router = useRouter();
  const [conn, setConn] = useState<"connecting" | "live" | "polling">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const refreshSoon = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 300);
    };

    const startPolling = () => {
      if (!poll) poll = setInterval(() => router.refresh(), 10_000);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/nights/${encodeURIComponent(nightId)}/events`);
      source.onopen = () => {
        setConn("live");
        stopPolling();
      };
      source.onmessage = refreshSoon;
      source.onerror = () => {
        setConn("polling");
        startPolling();
        // The browser retries on its own unless the stream was closed for good.
        if (source && source.readyState === EventSource.CLOSED) {
          source.close();
          setTimeout(connect, 5_000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      stopPolling();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [nightId, router]);

  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
      <span className={conn === "live" ? "size-2 rounded-full bg-ok" : conn === "polling" ? "size-2 rounded-full bg-warn" : "size-2 rounded-full bg-line"} aria-hidden />
      {conn === "live" ? "Updating live" : conn === "polling" ? "Refreshing every 10 s" : "Connecting…"}
    </span>
  );
}
