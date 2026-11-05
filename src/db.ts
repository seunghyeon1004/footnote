import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, balance_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pack_id TEXT NOT NULL, cents INTEGER NOT NULL,
    status TEXT NOT NULL, capture_id TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, question TEXT NOT NULL, fee_cents INTEGER NOT NULL,
    own_domain TEXT, status TEXT NOT NULL, error TEXT, answer_md TEXT, llm_json TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, answer_id TEXT NOT NULL, t TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT, answer_id TEXT NOT NULL, n INTEGER NOT NULL, url TEXT NOT NULL, title TEXT,
    domain TEXT NOT NULL, raw_score REAL, justification TEXT, share_pct REAL NOT NULL DEFAULT 0, share_cents INTEGER NOT NULL DEFAULT 0,
    dropped INTEGER NOT NULL DEFAULT 0, drop_reason TEXT, flags_json TEXT NOT NULL DEFAULT '[]', payee_json TEXT,
    UNIQUE(answer_id, n));
  CREATE TABLE IF NOT EXISTS creators (
    domain TEXT PRIMARY KEY, label TEXT, root TEXT NOT NULL, payee_method TEXT NOT NULL DEFAULT 'none',
    email TEXT, paypal_me TEXT, evidence_url TEXT, updated_at TEXT NOT NULL);
  -- one accrual per paid source; status uses the public payout vocabulary
  CREATE TABLE IF NOT EXISTS accruals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL UNIQUE, answer_id TEXT NOT NULL, domain TEXT NOT NULL,
    email TEXT, cents INTEGER NOT NULL, status TEXT NOT NULL, item_sid TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS accruals_status ON accruals(status);
  CREATE TABLE IF NOT EXISTS payout_batches (
    batch_id TEXT PRIMARY KEY, sender_batch_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, total_cents INTEGER NOT NULL,
    settled_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payout_items (
    sender_item_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, payout_item_id TEXT, email TEXT NOT NULL, cents INTEGER NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, verified INTEGER NOT NULL, received_at TEXT NOT NULL);
  `);
  return db;
}

export const now = () => new Date().toISOString();
export const rid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
