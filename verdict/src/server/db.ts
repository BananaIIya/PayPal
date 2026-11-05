// MVP 用 Node 内置的 SQLite，零安装。表结构对齐开发文档的数据模型，
// 额外增加文档没有列出但流程需要的表：messages、portal_tokens、timeline_events、provider_cache、sim_*。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function dataDir(): string {
  const dir = process.env.VERDICT_DATA_DIR ?? path.join(process.cwd(), '.data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  order_no TEXT NOT NULL UNIQUE,
  paypal_order_id TEXT UNIQUE,
  capture_id TEXT,
  buyer_name TEXT,
  buyer_email_hash TEXT,
  ship_address TEXT,
  items TEXT NOT NULL,
  listing_snapshot TEXT,
  current_listing TEXT,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  carrier TEXT,
  tracking_number TEXT,
  tracking_sim TEXT,
  shipped_weight_g INTEGER,
  batch TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS category_policies (
  merchant_id TEXT NOT NULL, category TEXT NOT NULL,
  returnable INTEGER NOT NULL, perishable INTEGER NOT NULL,
  safety_sensitive INTEGER NOT NULL, identity_required INTEGER NOT NULL,
  required_shots TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (merchant_id, category)
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  origin TEXT NOT NULL CHECK (origin IN ('paypal_dispute','portal','manual_import')),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('not_received','damaged','not_as_described','missing_items','return')),
  narrative TEXT,
  paypal_dispute_id TEXT UNIQUE,
  status TEXT NOT NULL,
  confirmed_quality_issue INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  scenario TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES claims(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('live_capture','paypal_dispute','uploaded','manual_import','reference')),
  sha256 TEXT NOT NULL,
  dhash TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('A','B','C','D')),
  mime_type TEXT NOT NULL,
  shot_label TEXT,
  challenge_id TEXT,
  capture_meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_claim ON evidence(claim_id);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  shot_label TEXT,
  code TEXT NOT NULL,
  action TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS portal_tokens (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  analyzer TEXT NOT NULL, code TEXT NOT NULL, direction TEXT NOT NULL, strength TEXT NOT NULL,
  confidence REAL NOT NULL, evidence_ids TEXT NOT NULL, basis_source TEXT NOT NULL,
  region TEXT, explanation TEXT NOT NULL, raw TEXT, provider TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_claim ON signals(claim_id);
CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  analyzer TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','unavailable','failed')),
  error TEXT, note TEXT, started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_claim ON analysis_runs(claim_id);
CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  seq INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('low','medium','high','insufficient')),
  score REAL NOT NULL, data_confidence REAL NOT NULL, merchant_risk REAL NOT NULL,
  incomplete INTEGER NOT NULL, suggested_action TEXT NOT NULL,
  report TEXT NOT NULL, signal_ids TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_claim ON verdicts(claim_id, seq);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  verdict_id TEXT NOT NULL REFERENCES verdicts(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  paypal_request_id TEXT UNIQUE,
  paypal_response TEXT,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paypal_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, resource_id TEXT,
  payload TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  sender TEXT NOT NULL CHECK (sender IN ('merchant','buyer')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS timeline_claim ON timeline_events(claim_id, at);
CREATE TABLE IF NOT EXISTS provider_cache (
  kind TEXT NOT NULL, sha256 TEXT NOT NULL, provider TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (kind, sha256)
);
CREATE TABLE IF NOT EXISTS sim_disputes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  due_at TEXT,
  buyer_message TEXT,
  log TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS sim_requests (
  request_id TEXT PRIMARY KEY, response TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_refunds (
  id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, amount REAL NOT NULL, created_at TEXT NOT NULL
);
`;

const g = globalThis as unknown as { __verdictDb?: DatabaseSync };

function ensureColumn(conn: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function db(): DatabaseSync {
  if (!g.__verdictDb) {
    const conn = new DatabaseSync(path.join(dataDir(), 'verdict.db'));
    conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    conn.exec(SCHEMA);
    // 已有的演示数据库也要能升级，所以用补列而不是改建表语句。
    ensureColumn(conn, 'orders', 'paypal_env', "paypal_env TEXT NOT NULL DEFAULT 'simulator'");
    ensureColumn(conn, 'claims', 'paypal_updated_at', 'paypal_updated_at TEXT');
    ensureColumn(conn, 'claims', 'paypal_status', 'paypal_status TEXT');
    g.__verdictDb = conn;
  }
  return g.__verdictDb;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function tx<T>(fn: () => T): T {
  const conn = db();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    conn.exec('COMMIT');
    return out;
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet<T>(key: string): T | null {
  const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function kvSet(key: string, value: unknown): void {
  db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
