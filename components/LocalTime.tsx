"use client";

import { useEffect, useState } from "react";

type Style = "time" | "datetime" | "date";

function format(iso: string, style: Style, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions =
    style === "time"
      ? { hour: "numeric", minute: "2-digit" }
      : style === "date"
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return d.toLocaleString("en-US", { ...opts, timeZone });
}

/**
 * Timestamps are stored in UTC. The server renders them in UTC, then the
 * browser swaps in the viewer's own time zone after hydration.
 */
export function LocalTime({ iso, style = "datetime", className }: { iso: string; style?: Style; className?: string }) {
  const [text, setText] = useState(() => format(iso, style, "UTC"));
  useEffect(() => {
    setText(format(iso, style));
  }, [iso, style]);
  return (
    <time dateTime={iso} className={className}>
      {text}
    </time>
  );
}
