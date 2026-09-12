/**
 * SQLite layer on node:sqlite - a real relational store with zero install
 * friction, which is the same reason the tool recommends it to the models it
 * writes prompts for.
 */
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 4000;

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('single-file','full-stack')),
  model_id   TEXT,
  spec_json  TEXT NOT NULL,
  options_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

CREATE TABLE IF NOT EXISTS packs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  strategy      TEXT NOT NULL,
  fits          INTEGER NOT NULL,
  stage_count   INTEGER NOT NULL,
  size_lines    INTEGER,
  size_tokens   INTEGER,
  pack_json     TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packs_project ON packs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_packs_created ON packs(created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  pack_id      TEXT REFERENCES packs(id) ON DELETE SET NULL,
  stage_key    TEXT,
  provider     TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  status       TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ms           INTEGER,
  attempts     INTEGER DEFAULT 1,
  error        TEXT,
  verify_json  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_pack ON runs(pack_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_keys (
  provider   TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  pack_id    TEXT REFERENCES packs(id) ON DELETE CASCADE,
  stage_key  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  path       TEXT,
  text       TEXT NOT NULL,
  files_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_pack ON artifacts(pack_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(config.dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .run('schema_version', '1', new Date().toISOString());
  return db;
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params) ?? null;
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* rollback of a dead tx is a non-event */ }
    throw err;
  }
}

export function stats() {
  const counts = {};
  for (const t of ['projects', 'packs', 'runs', 'provider_keys', 'settings']) {
    counts[t] = get(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0;
  }
  const byStatus = all('SELECT status, COUNT(*) AS n FROM runs GROUP BY status');
  const tokenUse = get(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
                               COALESCE(SUM(ms),0) AS ms FROM runs`);
  return { ...counts, runsByStatus: byStatus, tokenUse };
}

export function closeDb() {
  try { db?.close(); } catch { /* already closed */ }
  db = null;
}
