#!/usr/bin/env node
/**
 * forge-zero doctor
 *
 * One command that answers "is this install sane?" before anyone starts debugging
 * a prompt: runtime version, node:sqlite, writability, the module import graph
 * (the client has no bundler, so a typo only shows up at runtime in a browser),
 * catalogue integrity, composition across every preset, the test suite, and
 * whether provider hosts are reachable from here.
 */
import { readdirSync, readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
const ok = (name, detail = '') => results.push(['pass', name, detail]);
const bad = (name, detail = '') => results.push(['fail', name, detail]);
const warn = (name, detail = '') => results.push(['warn', name, detail]);

/* 1. runtime ---------------------------------------------------------- */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) ok(`node ${process.version}`, 'node:sqlite available');
else bad(`node ${process.version}`, 'requires >= 22.5 for node:sqlite');

try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a)');
  db.close();
  ok('node:sqlite', 'in-memory database opened');
} catch (err) {
  bad('node:sqlite', err.message);
}

try { await import('express'); ok('express', 'installed'); } catch { bad('express', 'run `npm install`'); }

/* 2. data directory --------------------------------------------------- */
const dataDir = join(ROOT, 'data');
try {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dataDir, '.doctor'), '.');
  ok('data directory writable', relative(ROOT, dataDir));
} catch (err) {
  bad('data directory', err.message);
}

/* 3. module graph ----------------------------------------------------- */
const files = [];
(function walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) files.push(p);
  }
})(ROOT);

const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}/gm;
const exportSets = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const names = new Set([...src.matchAll(EXPORT_DECL_RE)].map((m) => m[1]));
  for (const m of src.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop();
      if (n) names.add(n);
    }
  }
  if (/^export\s+default/m.test(src)) names.add('default');
  exportSets.set(f, names);
}
let missing = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+(?:[A-Za-z0-9_$]+\s*,\s*)?(?:\{([^}]*)\}\s*)?from\s*['"](\.[^'"]+)['"]/g)) {
    const target = join(dirname(f), m[2]);
    if (!existsSync(target) || !statSync(target).isFile()) {
      bad('import target missing', `${relative(ROOT, f)} -> ${m[2]}`);
      missing++;
      continue;
    }
    const wanted = (m[1] ?? '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const have = exportSets.get(target) ?? new Set();
    for (const w of wanted) {
      if (!have.has(w)) {
        bad('named export missing', `${relative(ROOT, f)} imports { ${w} } from ${m[2]}`);
        missing++;
      }
    }
  }
}
if (!missing) ok('module graph', `${files.length} files; every relative named import resolves to a real export`);

/* 4. catalogue + blueprint integrity ---------------------------------- */
try {
  const catalog = await import(join(ROOT, 'server/lib/catalog.js'));
  const blueprint = await import(join(ROOT, 'server/lib/blueprint.js'));
  const models = catalog.listModels();
  const orphanRules = Object.keys(blueprint.QUIRK_RULES).filter((q) => q !== 'fast-cheap' && !models.some((m) => m.quirks.includes(q)));
  const unknownQuirks = models.flatMap((m) => m.quirks.filter((q) => !(q in blueprint.QUIRK_RULES)));
  if (unknownQuirks.length) bad('catalogue quirks', unknownQuirks.join(','));
  else ok('catalogue', `${models.length} models / ${catalog.PROVIDERS.length} providers, all quirks mapped to rules`);
  if (orphanRules.length) warn('unused quirk rules', orphanRules.join(',') + ' (no model declares them yet)');
  const stale = models.filter((m) => m.verifiedAt !== catalog.VERIFIED_AT);
  if (stale.length) warn('mixed verification dates', `${stale.length} models not marked ${catalog.VERIFIED_AT}`);
} catch (err) {
  bad('catalogue load', err.message);
}

/* 5. composition smoke ------------------------------------------------ */
try {
  const { composePack } = await import(join(ROOT, 'server/lib/composer.js'));
  const { normalizeSpec, PRESETS } = await import(join(ROOT, 'server/lib/spec.js'));
  let worst = 0;
  for (const p of PRESETS) {
    const r = normalizeSpec({ ...p.spec, mode: p.mode }, p.mode);
    if (!r.ok) throw new Error(`preset ${p.id} invalid: ${r.errors.join('; ')}`);
    for (const modelId of ['llama-3.1-8b-instant', 'gemini-3-flash']) {
      const pack = composePack({ mode: p.mode, spec: r.spec, modelId });
      if (!pack.stages.length) throw new Error(`preset ${p.id}/${modelId} produced no stages`);
      worst = Math.max(worst, pack.stageCount);
    }
  }
  ok('composition', `${PRESETS.length} presets x 2 models compose cleanly; largest pack ${worst} stages`);
} catch (err) {
  bad('composition', err.message);
}

/* 6. tests ------------------------------------------------------------ */
try {
  const out = execFileSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const pass = Number(/# pass\s+(\d+)/.exec(out)?.[1] ?? 0);
  const fail = Number(/# fail\s+(\d+)/.exec(out)?.[1] ?? -1);
  if (fail === 0) ok('test suite', `${pass} passing`);
  else bad('test suite', `${fail} failing of ${pass + fail}`);
} catch (err) {
  bad('test suite', String(err.message).split('\n')[0]);
}

/* 7. egress (informational) ------------------------------------------ */
for (const [label, url] of [
  ['groq', 'https://api.groq.com/openai/v1/models'],
  ['google', 'https://generativelanguage.googleapis.com/v1beta/models'],
]) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    ok(`egress ${label}`, `HTTP ${res.status}`);
  } catch (err) {
    warn(`egress ${label}`, `${err?.cause?.code ?? err.message} - composing and exporting still work; "run stage" will not from this host`);
  }
}

const width = Math.max(...results.map((r) => r[1].length));
const glyph = { pass: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };
console.log(`\n  forge-zero doctor\n  ${'─'.repeat(70)}`);
for (const [level, name, detail] of results) {
  console.log(`  ${glyph[level]} ${name.padEnd(width)}  ${detail}`);
}
const failed = results.filter((r) => r[0] === 'fail').length;
console.log(`\n  ${failed ? `${failed} problem${failed > 1 ? 's' : ''} found` : 'all good'} · ${results.length} checks\n`);
process.exit(failed ? 1 : 0);
