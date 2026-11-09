// SQLite through Node's built-in driver (node:sqlite): no native build step,
// so `npm install && npm run dev` works for judges on any machine with Node 22.13+.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS club (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  tolerance_cents INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('treasurer','volunteer','officer')),
  email TEXT
);
CREATE TABLE IF NOT EXISTS item (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  description TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS night (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  float_cents INTEGER NOT NULL CHECK (float_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('setup','selling','closing','closed','deposited')),
  sample INTEGER NOT NULL DEFAULT 0,
  close_note TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  deposited_at TEXT
);
CREATE TABLE IF NOT EXISTS photo (
  sha256 TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestion (
  id TEXT PRIMARY KEY,
  night_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  photo_sha256 TEXT NOT NULL,
  model TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS count (
  night_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open','close')),
  counts_json TEXT NOT NULL,
  waste_json TEXT,
  photo_sha256 TEXT,
  suggestion_id TEXT,
  counted_by TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (night_id, kind)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  night_id TEXT NOT NULL,
  booth TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED','COMPLETED','DECLINED','REFUNDED')),
  items_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  capture_id TEXT,
  payer TEXT,
  funding TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  decline_reason TEXT,
  refund_id TEXT,
  created_at TEXT NOT NULL,
  captured_at TEXT,
  refunded_at TEXT,
  UNIQUE (night_id, code)
);
CREATE INDEX IF NOT EXISTS orders_night ON orders (night_id);
CREATE INDEX IF NOT EXISTS orders_capture ON orders (capture_id);
CREATE TABLE IF NOT EXISTS cash_count (
  id TEXT PRIMARY KEY,
  night_id TEXT NOT NULL,
  counted_by TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK (cents >= 0),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deposit (
  night_id TEXT PRIMARY KEY,
  depositor TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK (cents >= 0),
  slip_sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reimbursement (
  id TEXT PRIMARY KEY,
  night_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  payee_email TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK (cents > 0),
  memo TEXT NOT NULL,
  receipt_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','sent','failed')),
  approver TEXT,
  batch_id TEXT,
  item_id TEXT,
  payout_status TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notice (
  id TEXT PRIMARY KEY,
  night_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('info','amber','red')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_event (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  resource_id TEXT,
  verified INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  raw TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  night_id TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
`;

type GlobalWithDb = typeof globalThis & { __halftimeDb?: { path: string; db: DatabaseSync } };

export function db(): DatabaseSync {
  const g = globalThis as GlobalWithDb;
  const file = dbPath();
  if (g.__halftimeDb && g.__halftimeDb.path === file) return g.__halftimeDb.db;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  conn.exec(SCHEMA);
  g.__halftimeDb = { path: file, db: conn };
  return conn;
}

/** For tests: drop the cached connection so the next db() call opens HALFTIME_DB fresh. */
export function resetDbForTests(): void {
  const g = globalThis as GlobalWithDb;
  g.__halftimeDb?.db.close();
  delete g.__halftimeDb;
}

export function tx<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
