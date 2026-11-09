// Demo data: one club, its volunteers, a five-item menu and three sample games
// from earlier in the season. Sample games use recorded (simulated) orders and
// are labelled "sample" everywhere they appear. Tonight's game is always live.

import { db, tx } from "./db";
import {
  addCashCount, addNotice, createNight, insertOrder, markOrderCompleted, markOrderRefunded, saveCount, saveDeposit, setNightStatus,
  type OrderItem,
} from "./repo";

export const CLUB_NAME = "Lincoln High Band Boosters";

export const ITEMS = [
  { sku: "water", name: "Water", priceCents: 100, description: "16.9 oz clear plastic water bottle with a cap", sort: 1 },
  { sku: "sports", name: "Sports drink", priceCents: 200, description: "20 oz plastic bottle of colored sports drink", sort: 2 },
  { sku: "chips", name: "Chips", priceCents: 100, description: "single-serve bag of potato chips", sort: 3 },
  { sku: "candy", name: "Candy bar", priceCents: 150, description: "individually wrapped candy bar", sort: 4 },
  { sku: "hotdog", name: "Hot dog", priceCents: 300, description: "hot dog wrapped in aluminum foil", sort: 5 },
] as const;

export const PEOPLE = [
  { id: "p_dana", name: "Dana Reyes", role: "treasurer", email: null },
  { id: "p_marcus", name: "Marcus Hill", role: "volunteer", email: null },
  { id: "p_priya", name: "Priya Shah", role: "volunteer", email: null },
  { id: "p_jordan", name: "Jordan Lee", role: "volunteer", email: null },
  { id: "p_pat", name: "Pat Okafor", role: "officer", email: null },
  { id: "p_sam", name: "Sam Ortiz", role: "officer", email: null },
] as const;

// Small deterministic generator so the sample season is identical on every machine.
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

interface SampleGame {
  id: string; title: string; date: string; floatCents: number; seed: number;
  open: Record<string, number>; paypalOrders: number; refunds: number;
  /** Cash actually in the box relative to expected. */
  boxDeltaCents: number;
  /** Deposit relative to counted − float. */
  depositDeltaCents: number;
}

const SAMPLE_GAMES: SampleGame[] = [
  { id: "night_sample_0926", title: "vs. Westfield", date: "2026-09-26", floatCents: 10000, seed: 7,
    open: { water: 48, sports: 24, chips: 30, candy: 36, hotdog: 40 }, paypalOrders: 22, refunds: 1, boxDeltaCents: 0, depositDeltaCents: 0 },
  { id: "night_sample_1010", title: "vs. Central", date: "2026-10-10", floatCents: 10000, seed: 11,
    open: { water: 48, sports: 24, chips: 30, candy: 36, hotdog: 48 }, paypalOrders: 27, refunds: 0, boxDeltaCents: -300, depositDeltaCents: 0 },
  { id: "night_sample_1024", title: "vs. Northridge", date: "2026-10-24", floatCents: 10000, seed: 23,
    open: { water: 60, sports: 24, chips: 36, candy: 36, hotdog: 48 }, paypalOrders: 31, refunds: 0, boxDeltaCents: 0, depositDeltaCents: -2700 },
];

function seedGame(g: SampleGame): void {
  const rand = rng(g.seed);
  createNight({ id: g.id, title: g.title, date: g.date, floatCents: g.floatCents, sample: true });
  saveCount({ nightId: g.id, kind: "open", counts: g.open, countedBy: "Marcus Hill", checkedBy: "Priya Shah" });

  const remaining: Record<string, number> = { ...g.open };
  const paypalUnits: Record<string, number> = {};
  for (let i = 0; i < g.paypalOrders + g.refunds; i++) {
    const lines: OrderItem[] = [];
    for (const item of ITEMS) {
      if (rand() < 0.45 && (remaining[item.sku] ?? 0) > 8) {
        const q = 1 + Math.floor(rand() * 2);
        lines.push({ sku: item.sku, name: item.name, quantity: q, unitCents: item.priceCents });
      }
    }
    if (!lines.length) lines.push({ sku: "water", name: "Water", quantity: 1, unitCents: 100 });
    const total = lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
    const id = `SAMPLE-${g.id.slice(-4)}-${String(i + 1).padStart(3, "0")}`;
    insertOrder({ id, nightId: g.id, booth: "window", code: `S${String(i + 1).padStart(2, "0")}`, items: lines, totalCents: total, simulated: true });
    markOrderCompleted(id, { captureId: `SAMPLECAP-${id}`, items: lines, totalCents: total, payer: "sample buyer", funding: i % 4 === 0 ? "venmo" : "paypal" });
    if (i < g.refunds) {
      markOrderRefunded(id, `SAMPLEREF-${id}`);
    } else {
      for (const l of lines) {
        remaining[l.sku] = (remaining[l.sku] ?? 0) - l.quantity;
        paypalUnits[l.sku] = (paypalUnits[l.sku] ?? 0) + l.quantity;
      }
    }
  }

  // Cash sales: roughly as many units again as PayPal sold, never more than what is left.
  const close: Record<string, number> = {};
  let cashSales = 0;
  for (const item of ITEMS) {
    const left = remaining[item.sku] ?? 0;
    const cashUnits = Math.min(left - 2, Math.floor((paypalUnits[item.sku] ?? 0) * (0.8 + rand() * 0.6)));
    close[item.sku] = left - Math.max(0, cashUnits);
    cashSales += Math.max(0, cashUnits) * item.priceCents;
  }
  saveCount({ nightId: g.id, kind: "close", counts: close, waste: {}, countedBy: "Jordan Lee", checkedBy: "Marcus Hill" });

  const box = cashSales + g.floatCents + g.boxDeltaCents;
  addCashCount(g.id, "Jordan Lee", box);
  addCashCount(g.id, "Priya Shah", box);
  setNightStatus(g.id, "closed");
  saveDeposit({ nightId: g.id, depositor: "Dana Reyes", cents: box - g.floatCents + g.depositDeltaCents });
  setNightStatus(g.id, "deposited");

  if (g.depositDeltaCents !== 0) {
    addNotice({
      nightId: g.id,
      level: "red",
      title: `Deposit differs from counted cash by $${(Math.abs(g.depositDeltaCents) / 100).toFixed(2)}`,
      body: `${g.title} (${g.date}): two volunteers counted the cash box after the game, and the bank deposit recorded the next day is $${(Math.abs(g.depositDeltaCents) / 100).toFixed(2)} ${g.depositDeltaCents < 0 ? "lower" : "higher"} than that count minus the float. Please compare the deposit slip with the count sheet. This is a sample notice.`,
    });
  }
}

export function seedDemo(force = false): void {
  const conn = db();
  const existing = conn.prepare("SELECT COUNT(*) AS c FROM club").get() as { c: number };
  if (Number(existing.c) > 0 && !force) return;
  tx(() => {
    for (const t of ["audit", "webhook_event", "notice", "reimbursement", "deposit", "cash_count", "orders", "count", "suggestion", "night", "item", "person", "club"]) {
      conn.exec(`DELETE FROM ${t}`);
    }
    conn.prepare("INSERT INTO club (id, name, tolerance_cents) VALUES (1, ?, 100)").run(CLUB_NAME);
    for (const p of PEOPLE) conn.prepare("INSERT INTO person (id, name, role, email) VALUES (?, ?, ?, ?)").run(p.id, p.name, p.role, p.email);
    for (const i of ITEMS) conn.prepare("INSERT INTO item (sku, name, price_cents, description, sort) VALUES (?, ?, ?, ?, ?)").run(i.sku, i.name, i.priceCents, i.description, i.sort);
    for (const g of SAMPLE_GAMES) seedGame(g);
  });
}

export function ensureSeeded(): void {
  seedDemo(false);
}
