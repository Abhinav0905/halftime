"use client";

import { PayPalButtons, PayPalScriptProvider, usePayPalScriptReducer, type PayPalButtonsComponentProps } from "@paypal/react-paypal-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NightStatus } from "@/lib/repo";
import { formatCents } from "@/lib/money";
import { postJson, randomId, type ApiResult } from "./api";
import { buttonClass, cx } from "./ui";

interface MenuItem { sku: string; name: string; priceCents: number }
interface Line { sku: string; name: string; quantity: number; unitCents: number }
type Via = "paypal" | "venmo" | "offline";
interface Paid { code: string; items: Line[]; totalCents: number; via: Via }
interface Notice { tone: "warn" | "bad"; text: string }

type CreateOrderData = Parameters<NonNullable<PayPalButtonsComponentProps["createOrder"]>>[0];
type OnApproveData = Parameters<NonNullable<PayPalButtonsComponentProps["onApprove"]>>[0];
type OnApproveActions = Parameters<NonNullable<PayPalButtonsComponentProps["onApprove"]>>[1];

interface CreateResponse { id: string; code: string; totalCents: number; simulated: boolean }
interface CaptureResponse { status: "COMPLETED" | "PENDING"; code: string; items: Line[]; totalCents: number }

const VIA_LABEL: Record<Via, string> = { paypal: "PayPal", venmo: "Venmo", offline: "offline demo" };

function storageKey(nightId: string) {
  return `halftime:paid:${nightId}`;
}

export function BuyerMenu({
  nightId,
  clubName,
  gameTitle,
  status,
  items,
  maxPerLine,
  paypalClientId,
  mockDecline,
}: {
  nightId: string;
  clubName: string;
  gameTitle: string;
  status: NightStatus;
  items: MenuItem[];
  maxPerLine: number;
  paypalClientId: string | null;
  mockDecline: boolean;
}) {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [paid, setPaid] = useState<Paid | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [offline, setOffline] = useState(paypalClientId === null);
  const [busy, setBusy] = useState(false);
  const [standClosed, setStandClosed] = useState(status !== "selling");

  // PayPal's button keeps the callbacks from its first render, so they read
  // the latest cart through refs instead of closing over state.
  const cartRef = useRef(cart);
  const declineNext = useRef(mockDecline);
  const viaByOrder = useRef<Record<string, Via>>({});
  const errorShown = useRef(false);
  const declinedOffline = useRef<{ id: string; cartKey: string } | null>(null);
  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  // A fan who reloads the page should still see their pickup code.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey(nightId));
      if (saved) setPaid(JSON.parse(saved) as Paid);
    } catch {
      // Storage can be unavailable (private mode); the code is also on the window board.
    }
  }, [nightId]);

  const lines: Line[] = items
    .filter((i) => (cart[i.sku] ?? 0) > 0)
    .map((i) => ({ sku: i.sku, name: i.name, quantity: cart[i.sku] ?? 0, unitCents: i.priceCents }));
  const totalCents = lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
  const units = lines.reduce((s, l) => s + l.quantity, 0);

  function change(sku: string, delta: number) {
    setNotice(null);
    setCart((c) => {
      const next = Math.max(0, Math.min(maxPerLine, (c[sku] ?? 0) + delta));
      return { ...c, [sku]: next };
    });
  }

  const finish = useCallback(
    (data: CaptureResponse, via: Via) => {
      const result: Paid = { code: data.code, items: data.items, totalCents: data.totalCents, via };
      setPaid(result);
      setCart({});
      setNotice(null);
      try {
        sessionStorage.setItem(storageKey(nightId), JSON.stringify(result));
      } catch {
        // Not critical.
      }
      window.scrollTo({ top: 0 });
    },
    [nightId],
  );

  const showError = useCallback((n: Notice) => {
    errorShown.current = true;
    setNotice(n);
  }, []);

  /** Creates the order on our server, which prices the cart and calls PayPal. */
  const createOrder = useCallback(
    async (via: Via): Promise<CreateResponse> => {
      const cartNow = Object.fromEntries(Object.entries(cartRef.current).filter(([, q]) => q > 0));
      if (!Object.keys(cartNow).length) {
        showError({ tone: "warn", text: "Add something to your order first." });
        throw new Error("empty cart");
      }
      // One id per submission, reused if the request has to be retried.
      const body = { nightId, booth: "window", cart: cartNow, requestId: randomId() };
      let res = await postJson<CreateResponse>("/api/orders", body);
      if (!res.ok && res.status === 0) res = await postJson<CreateResponse>("/api/orders", body);
      if (!res.ok) {
        if (res.status === 409) setStandClosed(true);
        showError({ tone: "bad", text: res.error });
        throw new Error(res.error);
      }
      viaByOrder.current[res.data.id] = via;
      return res.data;
    },
    [nightId, showError],
  );

  /** Returns true when the caller should let the buyer try again (declined). */
  const capture = useCallback(
    async (orderId: string): Promise<{ result: ApiResult<CaptureResponse>; declined: boolean }> => {
      const result = await postJson<CaptureResponse>(`/api/orders/${encodeURIComponent(orderId)}/capture`, {
        mockDecline: declineNext.current,
      });
      const declined = !result.ok && result.status === 402;
      if (declined) {
        // ?decline=1 declines only the first attempt, so the retry can succeed on camera.
        declineNext.current = false;
        const issue = typeof result.data?.issue === "string" ? result.data.issue : "";
        showError({
          tone: "warn",
          text:
            issue === "INSTRUMENT_DECLINED"
              ? "That card was declined, so nothing was charged. Please choose another card or way to pay."
              : "The payment did not go through, so nothing was charged. Please try again.",
        });
      } else if (!result.ok) {
        showError({ tone: "bad", text: result.error });
      }
      return { result, declined };
    },
    [showError],
  );

  const onPayPalCreate = useCallback(
    async (data: CreateOrderData): Promise<string> => {
      setNotice(null);
      errorShown.current = false;
      const via: Via = data.paymentSource === "venmo" ? "venmo" : "paypal";
      const created = await createOrder(via);
      if (created.simulated) {
        // The server has no PayPal credentials after all; switch to the offline button.
        setOffline(true);
        showError({ tone: "warn", text: "PayPal is not connected on this server, so use the offline demo button below." });
        throw new Error("simulated order");
      }
      return created.id;
    },
    [createOrder, showError],
  );

  const onPayPalApprove = useCallback(
    async (data: OnApproveData, actions: OnApproveActions): Promise<void> => {
      const { result, declined } = await capture(data.orderID);
      if (result.ok && result.data.status === "PENDING") {
        // PayPal accepted the payment but is still reviewing it; the window board turns green when it clears.
        showError({ tone: "warn", text: `PayPal is still confirming this payment. Your pickup code is ${result.data.code}; the window will see it as soon as PayPal confirms.` });
        return;
      }
      if (result.ok) {
        finish(result.data, viaByOrder.current[data.orderID] ?? "paypal");
        return;
      }
      if (declined && result.data?.issue === "INSTRUMENT_DECLINED") {
        actions.restart();
      }
    },
    [capture, finish, showError],
  );

  const onPayPalError = useCallback(() => {
    if (errorShown.current) {
      errorShown.current = false;
      return;
    }
    setNotice({ tone: "bad", text: "PayPal could not finish the payment, and nothing was charged. Please try again." });
  }, []);

  const onPayPalCancel = useCallback(() => {
    setNotice({ tone: "warn", text: "Payment cancelled. Your order is still here when you are ready." });
  }, []);

  async function payOffline() {
    setBusy(true);
    setNotice(null);
    errorShown.current = false;
    try {
      // After a decline, retry the same order (as PayPal's restart does) unless the cart changed.
      const cartKey = JSON.stringify(cart);
      const retry = declinedOffline.current?.cartKey === cartKey ? declinedOffline.current.id : null;
      const orderId = retry ?? (await createOrder("offline")).id;
      const { result, declined } = await capture(orderId);
      declinedOffline.current = declined ? { id: orderId, cartKey } : null;
      if (result.ok) finish(result.data, "offline");
    } catch {
      // createOrder already showed the reason.
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setPaid(null);
    try {
      sessionStorage.removeItem(storageKey(nightId));
    } catch {
      // Ignore.
    }
  }

  if (paid) return <PickupCode paid={paid} gameTitle={gameTitle} onNewOrder={standClosed ? null : startOver} />;

  return (
    <div className="mx-auto max-w-md pb-6">
      <p className="text-sm font-medium text-muted">{clubName}</p>
      <h1 className="text-2xl font-bold tracking-tight text-ink">Concessions · {gameTitle}</h1>

      {standClosed ? (
        <div className="mt-6 rounded-xl border border-line bg-card p-5 text-center shadow-sm">
          <h2 className="text-xl font-semibold text-ink">The stand is closed</h2>
          <p className="mt-2 text-ink-soft">
            {status === "setup"
              ? "The volunteers are still setting up. Please check back in a few minutes."
              : `Thanks for supporting the ${clubName}. Ordering has ended for this game.`}
          </p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-soft">Pick your items, pay on your phone, then show your pickup code at the window.</p>

          <ul className="mt-5 divide-y divide-line rounded-xl border border-line bg-card shadow-sm">
            {items.map((item) => {
              const qty = cart[item.sku] ?? 0;
              return (
                <li key={item.sku} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-semibold text-ink">{item.name}</div>
                    <div className="text-sm text-muted tabular">{formatCents(item.priceCents)}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => change(item.sku, -1)}
                      disabled={qty === 0}
                      aria-label={`Remove one ${item.name}`}
                      className="flex size-12 items-center justify-center rounded-full border border-line bg-white text-2xl font-semibold text-ink disabled:opacity-30"
                    >
                      −
                    </button>
                    <span className="w-10 text-center text-xl font-bold tabular text-ink" aria-label={`${qty} ${item.name}`}>
                      {qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => change(item.sku, 1)}
                      disabled={qty >= maxPerLine}
                      aria-label={`Add one ${item.name}`}
                      className="flex size-12 items-center justify-center rounded-full bg-brand text-2xl font-semibold text-white disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex items-baseline justify-between rounded-xl bg-brand-soft px-4 py-3" aria-live="polite">
            <span className="text-ink-soft">
              {units ? `${units} ${units === 1 ? "item" : "items"}` : "Nothing added yet"}
            </span>
            <span className="text-3xl font-bold tabular text-ink">{formatCents(totalCents)}</span>
          </div>

          {notice && (
            <div
              role="alert"
              className={cx("mt-4 rounded-lg p-3 text-sm font-medium", notice.tone === "bad" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}
            >
              {notice.text}
            </div>
          )}

          <div className="mt-4">
            {offline || !paypalClientId ? (
              <div>
                <button
                  type="button"
                  className={`${buttonClass("primary", "lg")} w-full`}
                  disabled={busy || units === 0}
                  onClick={payOffline}
                >
                  {busy ? "Paying…" : `Pay ${formatCents(totalCents)} (offline demo)`}
                </button>
                <p className="mt-2 text-center text-xs text-muted">
                  This server has no PayPal sandbox keys, so payments are recorded without PayPal. No money moves.
                </p>
              </div>
            ) : (
              <PayPalScriptProvider
                options={{
                  clientId: paypalClientId,
                  currency: "USD",
                  intent: "capture",
                  components: "buttons",
                  enableFunding: "venmo",
                  // Sandbox only shows the Venmo button to US buyers.
                  buyerCountry: "US",
                }}
              >
                <PayPalArea
                  disabled={units === 0}
                  createOrder={onPayPalCreate}
                  onApprove={onPayPalApprove}
                  onError={onPayPalError}
                  onCancel={onPayPalCancel}
                />
              </PayPalScriptProvider>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PayPalArea({
  disabled,
  createOrder,
  onApprove,
  onError,
  onCancel,
}: {
  disabled: boolean;
  createOrder: (data: CreateOrderData) => Promise<string>;
  onApprove: (data: OnApproveData, actions: OnApproveActions) => Promise<void>;
  onError: () => void;
  onCancel: () => void;
}) {
  const [{ isPending, isRejected }] = usePayPalScriptReducer();
  if (isRejected) {
    return (
      <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm font-medium text-bad">
        PayPal did not load. Check your signal and reload the page, or pay with cash at the window.
      </p>
    );
  }
  const shared = { createOrder, onApprove, onError, onCancel, disabled };
  return (
    <div className="space-y-1">
      {isPending && <div className="h-12 animate-pulse rounded-lg bg-line" aria-label="Loading PayPal" />}
      {disabled && !isPending && <p className="pb-1 text-center text-sm text-muted">Add an item to pay.</p>}
      <PayPalButtons {...shared} fundingSource="paypal" style={{ layout: "vertical", shape: "rect", label: "pay", height: 48 }} />
      <PayPalButtons {...shared} fundingSource="venmo" style={{ layout: "vertical", shape: "rect", height: 48 }} />
    </div>
  );
}

function PickupCode({ paid, gameTitle, onNewOrder }: { paid: Paid; gameTitle: string; onNewOrder: (() => void) | null }) {
  return (
    <div className="mx-auto max-w-md text-center">
      <div className="rounded-2xl border-2 border-ok bg-ok-soft px-4 py-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-ok">Paid · {gameTitle}</p>
        <p className="mt-3 text-lg text-ink">Show this at the window</p>
        <p className="mt-2 font-mono text-8xl font-bold tracking-widest text-ink" aria-label={`Pickup code ${paid.code.split("").join(" ")}`}>
          {paid.code}
        </p>
      </div>
      <ul className="mt-5 divide-y divide-line rounded-xl border border-line bg-card text-left shadow-sm">
        {paid.items.map((l) => (
          <li key={l.sku} className="flex items-baseline gap-3 px-4 py-3">
            <span className="text-xl font-bold tabular text-ink">{l.quantity} ×</span>
            <span className="flex-1 text-lg text-ink">{l.name}</span>
            <span className="text-sm text-muted tabular">{formatCents(l.quantity * l.unitCents)}</span>
          </li>
        ))}
        <li className="flex items-baseline justify-between px-4 py-3">
          <span className="text-ink-soft">Paid with {VIA_LABEL[paid.via]}</span>
          <span className="text-xl font-bold tabular text-ink">{formatCents(paid.totalCents)}</span>
        </li>
      </ul>
      {onNewOrder && (
        <button type="button" className={`${buttonClass("secondary", "lg")} mt-5 w-full`} onClick={onNewOrder}>
          Start a new order
        </button>
      )}
    </div>
  );
}
