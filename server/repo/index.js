/**
 * Repositories. Small by design: SQLite statements live here and nowhere else,
 * routes stay readable, and JSON columns hold only whole documents that are
 * never queried field-by-field (the pack itself, the brief, verify results).
 */
import crypto from 'node:crypto';
import { all, get, run } from '../db.js';
import { encryptSecret, decryptSecret, keyInfo } from '../lib/crypto.js';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const j = (v) => (v == null ? null : JSON.stringify(v));
const parse = (v, fallback = null) => {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

/* ------------------------------- projects ------------------------------ */

export const projects = {
  list({ limit = 50 } = {}) {
    return all(
      `SELECT id, name, mode, model_id, created_at, updated_at,
              (SELECT COUNT(*) FROM packs p WHERE p.project_id = projects.id) AS pack_count
       FROM projects ORDER BY updated_at DESC LIMIT ?`, [limit]
    );
  },
  get(projectId) {
    const row = get('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!row) return null;
    return {
      ...row,
      spec: parse(row.spec_json, {}),
      options: parse(row.options_json, {}),
      packs: packs.forProject(row.id),
    };
  },
  create({ name, mode, modelId, spec, options }) {
    const newId = id('prj');
    const ts = now();
    run(
      `INSERT INTO projects (id,name,mode,model_id,spec_json,options_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [newId, name || 'Untitled build', mode, modelId ?? null, j(spec), j(options ?? {}), ts, ts]
    );
    return projects.get(newId);
  },
  update(projectId, patch) {
    const current = get('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!current) return null;
    run(
      `UPDATE projects SET name=?, mode=?, model_id=?, spec_json=?, options_json=?, updated_at=? WHERE id=?`,
      [
        patch.name ?? current.name,
        patch.mode ?? current.mode,
        patch.modelId ?? current.model_id,
        j(patch.spec ?? parse(current.spec_json, {})),
        j(patch.options ?? parse(current.options_json, {})),
        now(),
        projectId,
      ]
    );
    return projects.get(projectId);
  },
  remove(projectId) {
    return run('DELETE FROM projects WHERE id = ?', [projectId]).changes > 0;
  },
};

/* -------------------------------- packs -------------------------------- */

export const packs = {
  save({ projectId = null, mode, modelId, strategy, fits, sizeLines, sizeTokens, stageCount, pack }) {
    const newId = id('pck');
    const ts = now();
    run(
      `INSERT INTO packs (id,project_id,mode,model_id,strategy,fits,stage_count,size_lines,size_tokens,pack_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId, projectId, mode, modelId, strategy, fits ? 1 : 0, stageCount, sizeLines ?? null, sizeTokens ?? null, j(pack), ts]
    );
    return newId;
  },
  get(packId) {
    const row = get('SELECT * FROM packs WHERE id = ?', [packId]);
    if (!row) return null;
    return { ...row, pack: parse(row.pack_json, null), fits: !!row.fits, runs: runs.forPack(row.id) };
  },
  forProject(projectId) {
    return all(
      'SELECT id, mode, model_id, strategy, fits, stage_count, size_lines, size_tokens, created_at FROM packs WHERE project_id = ? ORDER BY created_at DESC LIMIT 25',
      [projectId]
    ).map((r) => ({ ...r, fits: !!r.fits }));
  },
  recent(limit = 20) {
    return all(
      'SELECT id, project_id, mode, model_id, strategy, fits, stage_count, size_tokens, created_at FROM packs ORDER BY created_at DESC LIMIT ?',
      [limit]
    ).map((r) => ({ ...r, fits: !!r.fits }));
  },
  remove(packId) {
    return run('DELETE FROM packs WHERE id = ?', [packId]).changes > 0;
  },
};

/* -------------------------------- runs --------------------------------- */

export const runs = {
  start({ packId, stageKey, provider, modelId }) {
    const newId = id('run');
    run(
      `INSERT INTO runs (id,pack_id,stage_key,provider,model_id,status,created_at) VALUES (?,?,?,?,?,?,?)`,
      [newId, packId ?? null, stageKey ?? null, provider, modelId, 'running', now()]
    );
    return newId;
  },
  finish(runId, { status, inputTokens, outputTokens, ms, error, verify, attempts }) {
    run(
      `UPDATE runs SET status=?, input_tokens=?, output_tokens=?, ms=?, error=?, verify_json=?, attempts=? WHERE id=?`,
      [status, inputTokens ?? null, outputTokens ?? null, ms ?? null, error ?? null, j(verify ?? null), attempts ?? 1, runId]
    );
  },
  forPack(packId, limit = 20) {
    return all('SELECT * FROM runs WHERE pack_id = ? ORDER BY created_at DESC LIMIT ?', [packId, limit]);
  },
  recent(limit = 25) {
    return all('SELECT id,pack_id,stage_key,provider,model_id,status,input_tokens,output_tokens,ms,error,created_at FROM runs ORDER BY created_at DESC LIMIT ?', [limit]);
  },
};

/* ---------------------------- provider keys ----------------------------- */

/** Env fallback so a headless server can be configured without the UI at all. */
function keyFromEnv(providerId) {
  const up = String(providerId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return process.env[`FORGE_${up}_API_KEY`] ?? process.env[`${up}_API_KEY`] ?? null;
}

export const keys = {
  list(providerIds) {
    const rows = all('SELECT * FROM provider_keys');
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return providerIds.map((pid) => {
      const row = byProvider.get(pid) ?? null;
      const envKey = keyFromEnv(pid);
      const plaintext = row ? decryptSecret(row) : envKey;
      return {
        ...keyInfo(pid, row, plaintext),
        source: row ? (row.source ?? 'db') : envKey ? 'env' : null,
        fromEnv: !row && !!envKey,
      };
    });
  },
  get(providerId) {
    const row = get('SELECT * FROM provider_keys WHERE provider = ?', [providerId]);
    if (row) {
      const plaintext = decryptSecret(row);
      return { row, plaintext, source: row.source ?? 'db' };
    }
    const envKey = keyFromEnv(providerId);
    if (envKey) return { row: null, plaintext: envKey, source: 'env' };
    return { row: null, plaintext: null, source: null };
  },
  set(providerId, plaintext) {
    const enc = encryptSecret(plaintext);
    const ts = now();
    run(
      `INSERT INTO provider_keys (provider,ciphertext,iv,tag,source,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(provider) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag,
         source=excluded.source, updated_at=excluded.updated_at`,
      [providerId, enc.ciphertext, enc.iv, enc.tag, 'db', ts, ts]
    );
    return keys.get(providerId);
  },
  remove(providerId) {
    return run('DELETE FROM provider_keys WHERE provider = ?', [providerId]).changes > 0;
  },
};

/* ------------------------------ artifacts ------------------------------- */

export const artifacts = {
  save({ packId, stageKey, kind = 'code', text, files = [], path = null }) {
    const newId = id('art');
    run(
      `INSERT INTO artifacts (id,pack_id,stage_key,kind,path,text,files_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [newId, packId ?? null, stageKey, kind, path, text, j(files), now()]
    );
    return newId;
  },
  forPack(packId) {
    return all(
      'SELECT id,stage_key,kind,path,text,files_json,created_at FROM artifacts WHERE pack_id = ? ORDER BY created_at ASC',
      [packId]
    ).map((r) => ({ ...r, files: parse(r.files_json, []) }));
  },
  get(artifactId) {
    const r = get('SELECT * FROM artifacts WHERE id = ?', [artifactId]);
    return r ? { ...r, files: parse(r.files_json, []) } : null;
  },
  latest(packId, stageKey) {
    const r = get(
      'SELECT * FROM artifacts WHERE pack_id = ? AND stage_key = ? ORDER BY created_at DESC LIMIT 1',
      [packId, stageKey]
    );
    return r ? { ...r, files: parse(r.files_json, []) } : null;
  },
};

/* ------------------------------ settings -------------------------------- */

export const settings = {
  get(keyName, fallback = null) {
    const row = get('SELECT value_json FROM settings WHERE key = ?', [keyName]);
    return row ? parse(row.value_json, fallback) : fallback;
  },
  set(keyName, value) {
    run(
      `INSERT INTO settings (key,value_json,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      [keyName, j(value), now()]
    );
    return value;
  },
};
