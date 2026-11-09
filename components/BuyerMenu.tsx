"use client";

import { PayPalButtons, PayPalScriptProvider, usePayPalScriptReducer, type PayPalButtonsComponentProps } from "@paypal/react-paypal-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NightStatus } from "@/lib/repo";
import { formatCents } from "@/lib/money";
import { getJson, postJson, randomId, type ApiResult } from "./api";
import { buttonClass, cx } from "./ui";

interface MenuItem { sku: string; name: string; priceCents: number }
interface Line { sku: string; name: string; quantity: number; unitCents: number }
type Via = "paypal" | "venmo" | "card" | "offline";
/**
 * What the pickup screen shows. `waiting` means PayPal has not confirmed the payment yet:
 * "review" when PayPal is holding it, "unconfirmed" when the answer never reached the phone.
 */
interface Paid { code: string; items: Line[]; totalCents: number; via: Via; orderId?: string; waiting?: "review" | "unconfirmed" }
interface Notice { tone: "warn" | "bad"; text: string }

type CreateOrderData = Parameters<NonNullable<PayPalButtonsComponentProps["createOrder"]>>[0];
type OnApproveData = Parameters<NonNullable<PayPalButtonsComponentProps["onApprove"]>>[0];
type OnApproveActions = Parameters<NonNullable<PayPalButtonsComponentProps["onApprove"]>>[1];

interface CreateResponse { id: string; code: string; totalCents: number; simulated: boolean }
interface OrderResponse { status: string; code: string; items?: Line[]; totalCents?: number }
interface OrderInfo { via: Via; code: string; items: Line[]; totalCents: number }

/** Where a payment stands after asking the server. "unsure" means it may or may not have gone through. */
type Settled =
  | { kind: "paid"; code: string; items: Line[]; totalCents: number }
  | { kind: "review" }
  | { kind: "declined"; issue: string }
  | { kind: "closed"; text: string }
  | { kind: "refused"; text: string }
  | { kind: "unsure" };

const VIA_LABEL: Record<Via, string> = { paypal: "PayPal", venmo: "Venmo", card: "card", offline: "offline demo" };

const CHECKING = "Confirming your payment with PayPal. Please don't pay again.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function storageKey(nightId: string) {
  return `halftime:paid:${nightId}`;
}

/** A saved pickup screen, or null if storage holds something this version can't show. */
function readPaid(raw: string | null): Paid | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Paid> | null;
    if (v && typeof v.code === "string" && Array.isArray(v.items) && typeof v.totalCents === "number" && v.via && v.via in VIA_LABEL) {
      return v as Paid;
    }
  } catch {
    // Fall through.
  }
  return null;
}

function declinedText(issue: string): string {
  return issue === "INSTRUMENT_DECLINED"
    ? "That card was declined, so nothing was charged. Please choose another card or way to pay."
    : "The payment did not go through, so nothing was charged. Please try again.";
}

function fromCapture(result: ApiResult<OrderResponse>): Settled {
  if (result.ok) {
    const { status, code, items, totalCents } = result.data;
    if (status === "COMPLETED" && items && totalCents !== undefined) return { kind: "paid", code, items, totalCents };
    return { kind: "review" };
  }
  if (result.status === 402) return { kind: "declined", issue: typeof result.data?.issue === "string" ? result.data.issue : "" };
  if (result.status === 409 && result.data?.reason === "STAND_CLOSED") return { kind: "closed", text: result.error };
  // No answer, or the server could not get one from PayPal.
  if (result.status === 0 || result.status >= 500) return { kind: "unsure" };
  return { kind: "refused", text: result.error };
}

function fromStatus(result: ApiResult<OrderResponse>): Settled {
  if (!result.ok) return { kind: "unsure" };
  const { status, code, items, totalCents } = result.data;
  if (status === "COMPLETED" && items && totalCents !== undefined) return { kind: "paid", code, items, totalCents };
  if (status === "DECLINED") return { kind: "declined", issue: "" };
  if (status === "REFUNDED") return { kind: "refused", text: "The club refunded this order. Please ask at the window if you have questions." };
  return { kind: "unsure" };
}

const orderUrl = (orderId: string) => `/api/orders/${encodeURIComponent(orderId)}`;

function postCapture(orderId: string, mockDecline: boolean) {
  return postJson<OrderResponse>(`${orderUrl(orderId)}/capture`, { mockDecline });
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
  const orderInfo = useRef<Record<string, OrderInfo>>({});
  const errorShown = useRef(false);
  const declinedOffline = useRef<{ id: string; cartKey: string } | null>(null);
  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  // A fan who reloads the page should still see their pickup code.
  useEffect(() => {
    try {
      const saved = readPaid(sessionStorage.getItem(storageKey(nightId)));
      if (saved) setPaid(saved);
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

  const savePaid = useCallback(
    (next: Paid | null) => {
      setPaid(next);
      try {
        if (next) sessionStorage.setItem(storageKey(nightId), JSON.stringify(next));
        else sessionStorage.removeItem(storageKey(nightId));
      } catch {
        // Not critical.
      }
    },
    [nightId],
  );

  const showError = useCallback((n: Notice) => {
    errorShown.current = true;
    setNotice(n);
  }, []);

  /**
   * Act on where a payment stands. Until PayPal confirms it one way or the other, the cart is
   * locked and the pay buttons are gone, so a fan can't pay twice for one order.
   */
  const settle = useCallback(
    (orderId: string, info: OrderInfo, outcome: Settled) => {
      switch (outcome.kind) {
        case "paid":
          savePaid({ code: outcome.code, items: outcome.items, totalCents: outcome.totalCents, via: info.via });
          setCart({});
          setNotice(null);
          window.scrollTo({ top: 0 });
          return;
        case "review":
        case "unsure":
          savePaid({ ...info, orderId, waiting: outcome.kind === "review" ? "review" : "unconfirmed" });
          setCart({});
          setNotice(null);
          window.scrollTo({ top: 0 });
          return;
        case "declined":
          showError({ tone: "warn", text: declinedText(outcome.issue) });
          return;
        case "closed":
          setStandClosed(true);
          showError({ tone: "warn", text: outcome.text });
          return;
        case "refused":
          showError({ tone: "bad", text: outcome.text });
          return;
      }
    },
    [savePaid, showError],
  );

  /** Capture, and if the answer is lost, check with the server before anything else. */
  const captureAndConfirm = useCallback(async (orderId: string): Promise<Settled> => {
    const first = await postCapture(orderId, declineNext.current);
    if (first.status === 402) {
      // ?decline=1 declines only the first attempt, so the retry can succeed on camera.
      declineNext.current = false;
    }
    let outcome = fromCapture(first);
    if (outcome.kind !== "unsure") return outcome;

    setNotice({ tone: "warn", text: CHECKING });
    for (const wait of [1500, 3000, 5000]) {
      await sleep(wait);
      outcome = fromStatus(await getJson<OrderResponse>(orderUrl(orderId)));
      if (outcome.kind !== "unsure") return outcome;
    }
    // Still not recorded. Asking again is safe: PayPal-Request-Id capture-<order id> allows one charge per order.
    return fromCapture(await postCapture(orderId, false));
  }, []);

  // While PayPal has not confirmed a payment, keep checking. For an answer that never reached
  // the phone, also ask the server to capture again now and then, in case the first request
  // never got there.
  const waitingOrder = paid?.waiting && paid.orderId ? paid : null;
  useEffect(() => {
    if (!waitingOrder?.orderId) return;
    const { orderId, waiting } = waitingOrder;
    const info: OrderInfo = { via: waitingOrder.via, code: waitingOrder.code, items: waitingOrder.items, totalCents: waitingOrder.totalCents };
    let stopped = false;
    void (async () => {
      let lastCapture = Date.now();
      for (let round = 0; !stopped; round++) {
        await sleep(round < 5 ? 3000 : 10_000);
        if (stopped) return;
        let outcome = fromStatus(await getJson<OrderResponse>(orderUrl(orderId)));
        if (outcome.kind === "unsure" && waiting === "unconfirmed" && Date.now() - lastCapture > 20_000) {
          lastCapture = Date.now();
          outcome = fromCapture(await postCapture(orderId, false));
        }
        if (stopped || outcome.kind === "unsure" || (outcome.kind === "review" && waiting === "review")) continue;
        if (outcome.kind === "declined" || outcome.kind === "closed" || outcome.kind === "refused") {
          // Back to the menu with the same items, so paying again is one tap.
          savePaid(null);
          setCart(Object.fromEntries(info.items.map((l) => [l.sku, l.quantity])));
        }
        settle(orderId, info, outcome);
        return;
      }
    })();
    return () => {
      stopped = true;
    };
  }, [waitingOrder, savePaid, settle]);

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
      const ordered = items
        .filter((i) => (cartNow[i.sku] ?? 0) > 0)
        .map((i) => ({ sku: i.sku, name: i.name, quantity: cartNow[i.sku] ?? 0, unitCents: i.priceCents }));
      orderInfo.current[res.data.id] = { via, code: res.data.code, items: ordered, totalCents: res.data.totalCents };
      return res.data;
    },
    [items, nightId, showError],
  );

  const onPayPalCreate = useCallback(
    async (data: CreateOrderData): Promise<string> => {
      setNotice(null);
      errorShown.current = false;
      const via: Via = data.paymentSource === "venmo" ? "venmo" : data.paymentSource === "card" ? "card" : "paypal";
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
      const info = orderInfo.current[data.orderID] ?? { via: "paypal", code: "", items: [], totalCents: 0 };
      const outcome = await captureAndConfirm(data.orderID);
      settle(data.orderID, info, outcome);
      // PayPal's documented way to let the buyer pick another card in the same popup.
      if (outcome.kind === "declined" && outcome.issue === "INSTRUMENT_DECLINED") return actions.restart();
    },
    [captureAndConfirm, settle],
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
      const outcome = await captureAndConfirm(orderId);
      declinedOffline.current = outcome.kind === "declined" ? { id: orderId, cartKey } : null;
      settle(orderId, orderInfo.current[orderId] ?? { via: "offline", code: "", items: lines, totalCents }, outcome);
    } catch {
      // createOrder already showed the reason.
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    savePaid(null);
  }

  if (paid) return <PickupCode paid={paid} gameTitle={gameTitle} onNewOrder={standClosed || paid.waiting ? null : startOver} />;

  const noticeBox = notice && (
    <div
      role="alert"
      className={cx("mt-4 rounded-lg p-3 text-sm font-medium", notice.tone === "bad" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}
    >
      {notice.text}
    </div>
  );

  return (
    <div className="mx-auto max-w-md pb-6">
      <p className="text-sm font-medium text-muted">{clubName}</p>
      <h1 className="text-2xl font-bold tracking-tight text-ink">Concessions · {gameTitle}</h1>

      {standClosed ? (
        <>
          {noticeBox}
          <div className="mt-6 rounded-xl border border-line bg-card p-5 text-center shadow-sm">
            <h2 className="text-xl font-semibold text-ink">The stand is closed</h2>
            <p className="mt-2 text-ink-soft">
              {status === "setup"
                ? "The volunteers are still setting up. Please check back in a few minutes."
                : `Thanks for supporting the ${clubName}. Ordering has ended for this game.`}
            </p>
          </div>
        </>
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

          {noticeBox}

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
      {/* Guest card checkout, for fans without a PayPal or Venmo account. */}
      <PayPalButtons {...shared} fundingSource="card" style={{ layout: "vertical", shape: "rect", height: 48 }} />
    </div>
  );
}

function PickupCode({ paid, gameTitle, onNewOrder }: { paid: Paid; gameTitle: string; onNewOrder: (() => void) | null }) {
  const waiting = Boolean(paid.waiting);
  return (
    <div className="mx-auto max-w-md text-center">
      <div className={cx("rounded-2xl border-2 px-4 py-8 shadow-sm", waiting ? "border-warn bg-warn-soft" : "border-ok bg-ok-soft")}>
        <p className={cx("text-sm font-semibold uppercase tracking-wide", waiting ? "text-warn" : "text-ok")}>
          {waiting ? "Waiting for PayPal" : "Paid"} · {gameTitle}
        </p>
        <p className="mt-3 text-lg text-ink">Show this at the window</p>
        <p className="mt-2 font-mono text-8xl font-bold tracking-widest text-ink" aria-label={`Pickup code ${paid.code.split("").join(" ")}`}>
          {paid.code}
        </p>
      </div>
      {waiting && (
        <p role="status" className="mt-4 rounded-lg bg-warn-soft p-3 text-sm font-medium text-warn">
          {paid.waiting === "review"
            ? "PayPal is still confirming this payment. This screen turns green when it does. Please don't pay again."
            : "We could not confirm this payment with PayPal yet. Please don't pay again. This screen updates by itself, and the window can look up your code."}
        </p>
      )}
      <ul className="mt-5 divide-y divide-line rounded-xl border border-line bg-card text-left shadow-sm">
        {paid.items.map((l) => (
          <li key={l.sku} className="flex items-baseline gap-3 px-4 py-3">
            <span className="text-xl font-bold tabular text-ink">{l.quantity} ×</span>
            <span className="flex-1 text-lg text-ink">{l.name}</span>
            <span className="text-sm text-muted tabular">{formatCents(l.quantity * l.unitCents)}</span>
          </li>
        ))}
        <li className="flex items-baseline justify-between px-4 py-3">
          <span className="text-ink-soft">{waiting ? "Paying" : "Paid"} with {VIA_LABEL[paid.via]}</span>
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
