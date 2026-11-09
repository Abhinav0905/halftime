// Data access. Every SQL statement in the app lives here.

import { db, nowIso, tx } from "./db";
import { newId } from "./ids";
import { reconcile, type CashStatus, type Counts, type ReconcileResult } from "./engine/reconcile";
import { isCashBlind } from "./redact";

// ---------- types ----------

export type NightStatus = "setup" | "selling" | "closing" | "closed" | "deposited";
export type CountKind = "open" | "close";
export type OrderStatus = "CREATED" | "COMPLETED" | "DECLINED" | "REFUNDED";

export interface Club { name: string; toleranceCents: number }
export interface Person { id: string; name: string; role: "treasurer" | "volunteer" | "officer"; email: string | null }
export interface Item { sku: string; name: string; priceCents: number; description: string; sort: number }
export interface Night {
  id: string; title: string; date: string; floatCents: number; status: NightStatus; sample: boolean;
  closeNote: string | null; createdAt: string; closedAt: string | null; depositedAt: string | null;
}
export interface CountRecord {
  nightId: string; kind: CountKind; counts: Counts; waste: Counts | null; photoSha256: string | null;
  suggestionId: string | null; countedBy: string; checkedBy: string; createdAt: string;
}
export interface OrderItem { sku: string; name: string; quantity: number; unitCents: number }
export interface OrderRow {
  id: string; nightId: string; booth: string; code: string; status: OrderStatus; items: OrderItem[];
  totalCents: number; captureId: string | null; payer: string | null; funding: string | null; simulated: boolean;
  declineReason: string | null; refundId: string | null; createdAt: string; capturedAt: string | null; refundedAt: string | null;
}
export interface CashCountRow { id: string; nightId: string; countedBy: string; cents: number; createdAt: string }
export interface DepositRow { nightId: string; depositor: string; cents: number; slipSha256: string | null; createdAt: string }
export interface Reimbursement {
  id: string; nightId: string; requester: string; payeeEmail: string; cents: number; memo: string;
  receiptSha256: string | null; status: "requested" | "sent" | "failed"; approver: string | null;
  batchId: string | null; itemId: string | null; payoutStatus: string | null; error: string | null;
  createdAt: string; updatedAt: string;
}
export interface Notice {
  id: string; nightId: string | null; level: "info" | "amber" | "red"; title: string; body: string;
  createdAt: string; readAt: string | null;
}
export interface Suggestion { id: string; nightId: string; kind: CountKind; photoSha256: string; model: string; result: unknown; createdAt: string }
export interface AuditRow { id: number; nightId: string | null; actor: string | null; action: string; detail: unknown; at: string }

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const n = (v: unknown) => Number(v);
const j = <T>(v: unknown): T => JSON.parse(String(v)) as T;

// ---------- club, people, catalog ----------

export function getClub(): Club {
  const r = db().prepare("SELECT name, tolerance_cents FROM club WHERE id = 1").get() as Row | undefined;
  return r ? { name: String(r.name), toleranceCents: n(r.tolerance_cents) } : { name: "Booster Club", toleranceCents: 100 };
}

export function listPeople(): Person[] {
  return (db().prepare("SELECT * FROM person ORDER BY role, name").all() as Row[]).map((r) => ({
    id: String(r.id), name: String(r.name), role: r.role as Person["role"], email: s(r.email),
  }));
}

export function listItems(): Item[] {
  return (db().prepare("SELECT * FROM item ORDER BY sort, name").all() as Row[]).map((r) => ({
    sku: String(r.sku), name: String(r.name), priceCents: n(r.price_cents), description: String(r.description), sort: n(r.sort),
  }));
}

// ---------- nights ----------

function toNight(r: Row): Night {
  return {
    id: String(r.id), title: String(r.title), date: String(r.date), floatCents: n(r.float_cents),
    status: r.status as NightStatus, sample: n(r.sample) === 1, closeNote: s(r.close_note),
    createdAt: String(r.created_at), closedAt: s(r.closed_at), depositedAt: s(r.deposited_at),
  };
}

export function createNight(input: { title: string; date: string; floatCents: number; sample?: boolean; id?: string }): string {
  const id = input.id ?? newId("night");
  db().prepare(
    "INSERT INTO night (id, title, date, float_cents, status, sample, created_at) VALUES (?, ?, ?, ?, 'setup', ?, ?)",
  ).run(id, input.title, input.date, input.floatCents, input.sample ? 1 : 0, nowIso());
  return id;
}

export function getNight(id: string): Night | null {
  const r = db().prepare("SELECT * FROM night WHERE id = ?").get(id) as Row | undefined;
  return r ? toNight(r) : null;
}

export function listNights(): Night[] {
  return (db().prepare("SELECT * FROM night ORDER BY date DESC, created_at DESC").all() as Row[]).map(toNight);
}

export function setNightStatus(id: string, status: NightStatus, closeNote?: string | null): void {
  const now = nowIso();
  if (status === "closed") {
    db().prepare("UPDATE night SET status = ?, closed_at = ?, close_note = ? WHERE id = ?").run(status, now, closeNote ?? null, id);
  } else if (status === "deposited") {
    db().prepare("UPDATE night SET status = ?, deposited_at = ? WHERE id = ?").run(status, now, id);
  } else {
    db().prepare("UPDATE night SET status = ? WHERE id = ?").run(status, id);
  }
}

// ---------- photos ----------

export function insertPhoto(p: { sha256: string; path: string; mime: string; bytes: number }): void {
  db().prepare("INSERT OR IGNORE INTO photo (sha256, path, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(p.sha256, p.path, p.mime, p.bytes, nowIso());
}

export function getPhoto(sha256: string): { sha256: string; path: string; mime: string; bytes: number } | null {
  const r = db().prepare("SELECT * FROM photo WHERE sha256 = ?").get(sha256) as Row | undefined;
  return r ? { sha256: String(r.sha256), path: String(r.path), mime: String(r.mime), bytes: n(r.bytes) } : null;
}

// ---------- AI suggestions and confirmed counts ----------

export function saveSuggestion(input: { nightId: string; kind: CountKind; photoSha256: string; model: string; result: unknown }): string {
  const id = newId("sug");
  db().prepare("INSERT INTO suggestion (id, night_id, kind, photo_sha256, model, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.nightId, input.kind, input.photoSha256, input.model, JSON.stringify(input.result), nowIso());
  return id;
}

export function getSuggestion(id: string): Suggestion | null {
  const r = db().prepare("SELECT * FROM suggestion WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  return {
    id: String(r.id), nightId: String(r.night_id), kind: r.kind as CountKind, photoSha256: String(r.photo_sha256),
    model: String(r.model), result: j(r.result_json), createdAt: String(r.created_at),
  };
}

function toCount(r: Row): CountRecord {
  return {
    nightId: String(r.night_id), kind: r.kind as CountKind, counts: j<Counts>(r.counts_json),
    waste: r.waste_json ? j<Counts>(r.waste_json) : null, photoSha256: s(r.photo_sha256), suggestionId: s(r.suggestion_id),
    countedBy: String(r.counted_by), checkedBy: String(r.checked_by), createdAt: String(r.created_at),
  };
}

export function saveCount(input: {
  nightId: string; kind: CountKind; counts: Counts; waste?: Counts | null; photoSha256?: string | null;
  suggestionId?: string | null; countedBy: string; checkedBy: string;
}): void {
  db().prepare(
    `INSERT INTO count (night_id, kind, counts_json, waste_json, photo_sha256, suggestion_id, counted_by, checked_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (night_id, kind) DO UPDATE SET counts_json = excluded.counts_json, waste_json = excluded.waste_json,
       photo_sha256 = excluded.photo_sha256, suggestion_id = excluded.suggestion_id, counted_by = excluded.counted_by,
       checked_by = excluded.checked_by, created_at = excluded.created_at`,
  ).run(
    input.nightId, input.kind, JSON.stringify(input.counts), input.waste ? JSON.stringify(input.waste) : null,
    input.photoSha256 ?? null, input.suggestionId ?? null, input.countedBy.trim(), input.checkedBy.trim(), nowIso(),
  );
}

export function getCounts(nightId: string): { open: CountRecord | null; close: CountRecord | null } {
  const rows = (db().prepare("SELECT * FROM count WHERE night_id = ?").all(nightId) as Row[]).map(toCount);
  return { open: rows.find((r) => r.kind === "open") ?? null, close: rows.find((r) => r.kind === "close") ?? null };
}

// ---------- orders ----------

function toOrder(r: Row): OrderRow {
  return {
    id: String(r.id), nightId: String(r.night_id), booth: String(r.booth), code: String(r.code),
    status: r.status as OrderStatus, items: j<OrderItem[]>(r.items_json), totalCents: n(r.total_cents),
    captureId: s(r.capture_id), payer: s(r.payer), funding: s(r.funding), simulated: n(r.simulated) === 1,
    declineReason: s(r.decline_reason), refundId: s(r.refund_id), createdAt: String(r.created_at),
    capturedAt: s(r.captured_at), refundedAt: s(r.refunded_at),
  };
}

export function insertOrder(o: { id: string; nightId: string; booth: string; code: string; items: OrderItem[]; totalCents: number; simulated?: boolean }): void {
  db().prepare(
    "INSERT INTO orders (id, night_id, booth, code, status, items_json, total_cents, simulated, created_at) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)",
  ).run(o.id, o.nightId, o.booth, o.code, JSON.stringify(o.items), o.totalCents, o.simulated ? 1 : 0, nowIso());
}

export function codeTaken(nightId: string, code: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM orders WHERE night_id = ? AND code = ?").get(nightId, code));
}

export function getOrder(id: string): OrderRow | null {
  const r = db().prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row | undefined;
  return r ? toOrder(r) : null;
}

export function getOrderByCaptureId(captureId: string): OrderRow | null {
  const r = db().prepare("SELECT * FROM orders WHERE capture_id = ?").get(captureId) as Row | undefined;
  return r ? toOrder(r) : null;
}

export function listOrders(nightId: string): OrderRow[] {
  return (db().prepare("SELECT * FROM orders WHERE night_id = ? ORDER BY created_at").all(nightId) as Row[]).map(toOrder);
}

/** Record a verified capture. Items and total come from PayPal's GET order, not from the browser. */
export function markOrderCompleted(id: string, p: { captureId: string; items: OrderItem[]; totalCents: number; payer: string | null; funding: string | null }): void {
  db().prepare(
    `UPDATE orders SET status = 'COMPLETED', capture_id = ?, items_json = ?, total_cents = ?, payer = ?, funding = ?,
       decline_reason = NULL, captured_at = COALESCE(captured_at, ?) WHERE id = ? AND status IN ('CREATED','DECLINED','COMPLETED')`,
  ).run(p.captureId, JSON.stringify(p.items), p.totalCents, p.payer, p.funding, nowIso(), id);
}

export function markOrderDeclined(id: string, reason: string): void {
  db().prepare("UPDATE orders SET status = 'DECLINED', decline_reason = ? WHERE id = ? AND status IN ('CREATED','DECLINED')").run(reason, id);
}

export function markOrderRefunded(id: string, refundId: string): void {
  db().prepare("UPDATE orders SET status = 'REFUNDED', refund_id = ?, refunded_at = COALESCE(refunded_at, ?) WHERE id = ? AND status = 'COMPLETED'")
    .run(refundId, nowIso(), id);
}

// ---------- cash, deposit ----------

export function addCashCount(nightId: string, countedBy: string, cents: number): void {
  db().prepare("INSERT INTO cash_count (id, night_id, counted_by, cents, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(newId("cash"), nightId, countedBy.trim(), cents, nowIso());
}

export function listCashCounts(nightId: string): CashCountRow[] {
  return (db().prepare("SELECT * FROM cash_count WHERE night_id = ? ORDER BY created_at, rowid").all(nightId) as Row[]).map((r) => ({
    id: String(r.id), nightId: String(r.night_id), countedBy: String(r.counted_by), cents: n(r.cents), createdAt: String(r.created_at),
  }));
}

export function saveDeposit(d: { nightId: string; depositor: string; cents: number; slipSha256?: string | null }): void {
  db().prepare(
    `INSERT INTO deposit (night_id, depositor, cents, slip_sha256, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (night_id) DO UPDATE SET depositor = excluded.depositor, cents = excluded.cents, slip_sha256 = excluded.slip_sha256, created_at = excluded.created_at`,
  ).run(d.nightId, d.depositor.trim(), d.cents, d.slipSha256 ?? null, nowIso());
}

export function getDeposit(nightId: string): DepositRow | null {
  const r = db().prepare("SELECT * FROM deposit WHERE night_id = ?").get(nightId) as Row | undefined;
  return r ? { nightId: String(r.night_id), depositor: String(r.depositor), cents: n(r.cents), slipSha256: s(r.slip_sha256), createdAt: String(r.created_at) } : null;
}

// ---------- reimbursements ----------

function toReimbursement(r: Row): Reimbursement {
  return {
    id: String(r.id), nightId: String(r.night_id), requester: String(r.requester), payeeEmail: String(r.payee_email),
    cents: n(r.cents), memo: String(r.memo), receiptSha256: s(r.receipt_sha256), status: r.status as Reimbursement["status"],
    approver: s(r.approver), batchId: s(r.batch_id), itemId: s(r.item_id), payoutStatus: s(r.payout_status), error: s(r.error),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function createReimbursement(input: { nightId: string; requester: string; payeeEmail: string; cents: number; memo: string; receiptSha256?: string | null }): string {
  const id = newId("reimb");
  const now = nowIso();
  db().prepare(
    `INSERT INTO reimbursement (id, night_id, requester, payee_email, cents, memo, receipt_sha256, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
  ).run(id, input.nightId, input.requester.trim(), input.payeeEmail.trim(), input.cents, input.memo.trim(), input.receiptSha256 ?? null, now, now);
  return id;
}

export function getReimbursement(id: string): Reimbursement | null {
  const r = db().prepare("SELECT * FROM reimbursement WHERE id = ?").get(id) as Row | undefined;
  return r ? toReimbursement(r) : null;
}

export function findReimbursementByPayout(p: { batchId?: string | null; itemId?: string | null }): Reimbursement | null {
  const r = db().prepare("SELECT * FROM reimbursement WHERE (item_id IS NOT NULL AND item_id = ?) OR (batch_id IS NOT NULL AND batch_id = ?)")
    .get(p.itemId ?? "", p.batchId ?? "") as Row | undefined;
  return r ? toReimbursement(r) : null;
}

export function listReimbursements(nightId: string): Reimbursement[] {
  return (db().prepare("SELECT * FROM reimbursement WHERE night_id = ? ORDER BY created_at").all(nightId) as Row[]).map(toReimbursement);
}

export function updateReimbursement(id: string, patch: Partial<Pick<Reimbursement, "status" | "approver" | "batchId" | "itemId" | "payoutStatus" | "error">>): void {
  const cols: Record<string, string> = { status: "status", approver: "approver", batchId: "batch_id", itemId: "item_id", payoutStatus: "payout_status", error: "error" };
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = cols[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(v === undefined ? null : (v as string | null));
  }
  if (!sets.length) return;
  db().prepare(`UPDATE reimbursement SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
}

// ---------- notices, webhooks, audit ----------

export function addNotice(input: { nightId: string | null; level: Notice["level"]; title: string; body: string }): string {
  const id = newId("ntc");
  db().prepare("INSERT INTO notice (id, night_id, level, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, input.nightId, input.level, input.title, input.body, nowIso());
  return id;
}

export function listNotices(nightId?: string): Notice[] {
  const rows = (nightId
    ? db().prepare("SELECT * FROM notice WHERE night_id = ? ORDER BY created_at DESC").all(nightId)
    : db().prepare("SELECT * FROM notice ORDER BY created_at DESC").all()) as Row[];
  return rows.map((r) => ({
    id: String(r.id), nightId: s(r.night_id), level: r.level as Notice["level"], title: String(r.title), body: String(r.body),
    createdAt: String(r.created_at), readAt: s(r.read_at),
  }));
}

export function unreadNoticeCount(): number {
  const r = db().prepare("SELECT COUNT(*) AS c FROM notice WHERE read_at IS NULL").get() as Row;
  return n(r.c);
}

export function markNoticeRead(id: string): void {
  db().prepare("UPDATE notice SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(nowIso(), id);
}

/** Returns false when PayPal re-sends an event we already stored (webhooks are at-least-once). */
export function insertWebhookEvent(e: { id: string; type: string; resourceId: string | null; verified: boolean; raw: string }): boolean {
  const res = db().prepare("INSERT OR IGNORE INTO webhook_event (id, type, resource_id, verified, received_at, raw) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.id, e.type, e.resourceId, e.verified ? 1 : 0, nowIso(), e.raw);
  return Number(res.changes) > 0;
}

/** Forget an event whose handling failed, so PayPal's retry is processed instead of skipped as a duplicate. */
export function deleteWebhookEvent(id: string): void {
  db().prepare("DELETE FROM webhook_event WHERE id = ?").run(id);
}

export function audit(nightId: string | null, actor: string | null, action: string, detail?: unknown): void {
  db().prepare("INSERT INTO audit (night_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)")
    .run(nightId, actor, action, detail === undefined ? null : JSON.stringify(detail), nowIso());
}

export function listAudit(nightId: string): AuditRow[] {
  return (db().prepare("SELECT * FROM audit WHERE night_id = ? ORDER BY id DESC LIMIT 200").all(nightId) as Row[]).map((r) => ({
    id: n(r.id), nightId: s(r.night_id), actor: s(r.actor), action: String(r.action), detail: r.detail ? j(r.detail) : null, at: String(r.at),
  }));
}

// ---------- aggregate views ----------

export interface NightState {
  club: Club;
  night: Night;
  items: Item[];
  people: Person[];
  open: CountRecord | null;
  close: CountRecord | null;
  orders: OrderRow[];
  cashCounts: CashCountRow[];
  deposit: DepositRow | null;
  reimbursements: Reimbursement[];
  notices: Notice[];
  recon: ReconcileResult;
}

export function reconcileNight(night: Night, club = getClub(), items = listItems()): ReconcileResult {
  const { open, close } = getCounts(night.id);
  const orders = listOrders(night.id);
  const cash = listCashCounts(night.id);
  const deposit = getDeposit(night.id);
  return reconcile({
    items: items.map((i) => ({ sku: i.sku, name: i.name, priceCents: i.priceCents })),
    open: open?.counts ?? null,
    close: close?.counts ?? null,
    waste: close?.waste ?? null,
    orders: orders.map((o) => ({ status: o.status, items: o.items, totalCents: o.totalCents })),
    floatCents: night.floatCents,
    cashCounts: cash.map((c) => ({ countedBy: c.countedBy, cents: c.cents })),
    depositCents: deposit?.cents ?? null,
    toleranceCents: club.toleranceCents,
  });
}

export function getNightState(id: string): NightState | null {
  const night = getNight(id);
  if (!night) return null;
  const club = getClub();
  const items = listItems();
  const { open, close } = getCounts(id);
  return {
    club, night, items, people: listPeople(), open, close,
    orders: listOrders(id), cashCounts: listCashCounts(id), deposit: getDeposit(id),
    reimbursements: listReimbursements(id), notices: listNotices(id),
    recon: reconcileNight(night, club, items),
  };
}

export interface LedgerRow {
  nightId: string; date: string; title: string; status: NightStatus; sample: boolean;
  paypalCents: number; paypalOrders: number; expectedCashSalesCents: number | null; expectedBoxCents: number | null;
  countedCents: number | null; floatCents: number; cashVarianceCents: number | null; cashBand: string | null;
  depositCents: number | null; depositVarianceCents: number | null; depositBand: string | null;
  totalSalesCents: number | null; recountSkus: string[]; cashStatus: CashStatus;
  /** The night is closing and the two cash counts don't agree yet, so the expected cash and totals are null. */
  cashHidden: boolean;
}

export function getLedger(): LedgerRow[] {
  const club = getClub();
  const items = listItems();
  return listNights().map((night) => {
    const r = reconcileNight(night, club, items);
    // The season page is open to every volunteer, including the two counting the box.
    const hidden = isCashBlind(night.status, r.cash.status);
    return {
      nightId: night.id, date: night.date, title: night.title, status: night.status, sample: night.sample,
      paypalCents: r.paypalCents, paypalOrders: r.paypalOrders, expectedCashSalesCents: hidden ? null : r.expectedCashSalesCents,
      expectedBoxCents: hidden ? null : r.expectedBoxCents, countedCents: r.cash.countedCents, floatCents: night.floatCents,
      cashVarianceCents: r.cashVarianceCents, cashBand: r.cashBand, depositCents: r.depositCents,
      depositVarianceCents: r.depositVarianceCents, depositBand: r.depositBand, totalSalesCents: hidden ? null : r.totalSalesCents,
      recountSkus: r.recountSkus, cashStatus: r.cash.status, cashHidden: hidden,
    };
  });
}

export { tx };
