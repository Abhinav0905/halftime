"use client";

import { useSyncExternalStore } from "react";
import { formatGameDate, todayLocalIso } from "./format";

const noSubscribe = () => () => {};

/**
 * True when the game date is today on this phone or laptop. The server can't
 * know the viewer's day (a UTC host is already on tomorrow by evening in the
 * US), so it always renders the plain date and the browser swaps in "Tonight".
 */
export function useIsToday(date: string): boolean {
  return useSyncExternalStore(noSubscribe, () => todayLocalIso() === date, () => false);
}

/** "Tonight" for today's game, otherwise the date. */
export function GameDayLabel({ date, className }: { date: string; className?: string }) {
  const today = useIsToday(date);
  return <span className={className}>{today ? "Tonight" : formatGameDate(date, { year: true })}</span>;
}

/** The date, shown under the title only when the label above it says "Tonight". */
export function TonightDate({ date, className }: { date: string; className?: string }) {
  const today = useIsToday(date);
  return today ? <p className={className}>{formatGameDate(date, { year: true })}</p> : null;
}
