// In-process event bus for the window board (Server-Sent Events).
// One Node process serves the app, so an EventEmitter is enough.

import { EventEmitter } from "node:events";

export type NightEvent =
  | { type: "order.paid"; orderId: string; code: string }
  | { type: "order.declined"; orderId: string; code: string; reason: string }
  | { type: "order.refunded"; orderId: string; code: string }
  | { type: "count.saved"; kind: "open" | "close" }
  | { type: "cash.counted" }
  | { type: "night.status"; status: string }
  | { type: "reimbursement.updated"; id: string };

type GlobalWithBus = typeof globalThis & { __halftimeBus?: EventEmitter };

function bus(): EventEmitter {
  const g = globalThis as GlobalWithBus;
  if (!g.__halftimeBus) {
    g.__halftimeBus = new EventEmitter();
    g.__halftimeBus.setMaxListeners(500);
  }
  return g.__halftimeBus;
}

export function publish(nightId: string, event: NightEvent): void {
  bus().emit(`night:${nightId}`, event);
}

export function subscribe(nightId: string, fn: (e: NightEvent) => void): () => void {
  const key = `night:${nightId}`;
  bus().on(key, fn);
  return () => bus().off(key, fn);
}
