/**
 * The brief: Forge-Zero's input contract.
 *
 * Everything the composer knows about the user's idea arrives here, so this file
 * owns normalisation (trim, dedupe, coerce), the capability whitelist a prompt is
 * allowed to reference, and the preset gallery. Validation is hand-rolled rather
 * than pulled from a schema library: the rules are short, and the error messages
 * need to be *useful in the UI*, which is easier to guarantee without a dependency.
 */

import { STACKS } from './blueprint.js';

export const AMBITIONS = {
  mvp: { label: 'MVP', blurb: 'One flow, done properly. Smallest thing that is genuinely useful.', scale: 1 },
  polished: { label: 'Polished', blurb: 'Every listed feature, real states, keyboard support, looks designed.', scale: 1.9 },
  flagship: { label: 'Flagship', blurb: 'Portfolio-grade: dense feature list, edge cases handled, tests included.', scale: 3 },
};

/** The only third-party code a single-file brief may reference, pinned. */
export const CDN_LIBS = {
  marked: { label: 'marked (markdown)', url: 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js', global: 'marked', sizeKb: 40, use: 'Render user markdown' },
  dayjs: { label: 'dayjs (dates)', url: 'https://cdn.jsdelivr.net/npm/dayjs@1.11.13/dayjs.min.js', global: 'dayjs', sizeKb: 7, use: 'Relative date formatting' },
  papaparse: { label: 'Papaparse (CSV)', url: 'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js', global: 'Papa', sizeKb: 20, use: 'CSV import/export' },
  qrcode: { label: 'qrcode', url: 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js', global: 'QRCode', sizeKb: 40, use: 'Generate QR codes on canvas' },
  'chart-lite': { label: 'w3c-chart fallback-free sparkline', url: '', global: '', sizeKb: 0, use: 'Prefer inline SVG; listed here to say "do not import a chart lib"' },
};

export const PERSISTENCE = {
  local: 'localStorage, versioned key, survives reload',
  session: 'sessionStorage only, cleared on tab close',
  memory: 'in-memory only, no persistence claim anywhere in the UI',
  idb: 'IndexedDB (blob or >5MB record volume), with a localStorage fallback shim',
};

export const LAYOUTS = { 'mobile-first': 'usable one-handed at 360px, expands upward', 'desktop-first': 'dense at 1280px+, degrades to a single column', both: 'equal priority; grid reflows at 640/1024' };

/** Fields that only exist in one half of the toggle - the UI shows/hides these. */
export const MODE_SPEC_FIELDS = {
  'single-file': ['persistence', 'layout', 'allowCdn', 'offlineFirst', 'keyboardShortcuts', 'shareData'],
  'full-stack': ['stackId', 'auth', 'realtime', 'deploy', 'tests', 'seedVolume', 'multiUser'],
};

/** Approved stacks, straight from the blueprint so the two can never disagree. */
export const STACK_CHOICES = STACKS;

export const AUTH_CHOICES = { none: 'No auth (single user / local tool)', session: 'Email + password session cookie', roles: 'Session cookie plus an admin/member role split' };
export const REALTIME_CHOICES = { none: 'None - refetch after mutation', poll: 'Poll every N seconds', sse: 'Server-sent events on one stream' };
export const DEPLOY_CHOICES = { local: 'Local only, documented', 'cloudflare': 'Cloudflare Workers + D1 + Pages (free)', 'render': 'Render free web service + free Postgres', 'vps': 'Any VPS with systemd + caddy' };
export const TEST_CHOICES = { none: 'No tests', smoke: 'One node:test smoke file on the real server', full: 'Smoke plus per-resource unit tests' };

export function defaultSpec(mode = 'single-file') {
  return {
    mode,
    name: '',
    idea: '',
    audience: '',
    ambition: 'polished',
    features: [],
    entities: [],
    mustHave: [],
    avoid: [],
    notes: '',
    single: { persistence: 'local', layout: 'both', allowCdn: [], offlineFirst: true, keyboardShortcuts: false, shareData: false },
    stack: { stackId: 'node-express-sqlite', auth: 'none', realtime: 'none', deploy: 'local', tests: 'smoke', seedVolume: 40, multiUser: false },
  };
}

const asText = (v) => (typeof v === 'string' ? v.trim() : '');
const asList = (v) => {
  if (Array.isArray(v)) return v.map(asText).filter(Boolean);
  if (typeof v === 'string') return v.split(/\r?\n|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  return [];
};
const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const uniq = (arr) => [...new Set(arr)];

/**
 * Validate + normalise an incoming brief.
 * @returns {{ ok: boolean, spec?: object, errors?: string[], warnings?: string[] }}
 */
export function normalizeSpec(input = {}, mode = input.mode) {
  const errors = [];
  const warnings = [];
  const m = mode === 'full-stack' ? 'full-stack' : 'single-file';
  const base = defaultSpec(m);
  const spec = {
    ...base,
    ...input,
    mode: m,
    name: asText(input.name) || 'Untitled build',
    idea: asText(input.idea),
    audience: asText(input.audience),
    ambition: AMBITIONS[input.ambition] ? input.ambition : 'polished',
    features: uniq(asList(input.features)).slice(0, 14),
    entities: normalizeEntities(input.entities),
    mustHave: uniq(asList(input.mustHave)).slice(0, 12),
    avoid: uniq(asList(input.avoid)).slice(0, 12),
    notes: asText(input.notes),
    single: { ...base.single, ...(input.single || {}) },
    stack: { ...base.stack, ...(input.stack || {}) },
  };

  if (!spec.idea || spec.idea.length < 24) {
    errors.push('The idea needs at least ~6 words. A one-line pitch is what produces a generic app: "a thing for people who need a thing" tells the model nothing about the hard part.');
  }
  if (!spec.features.length) {
    warnings.push('No features listed - the model will infer them and will infer the shortest version of each.');
  }
  if (m === 'full-stack') {
    if (!spec.entities.length) {
      warnings.push('No data entities declared. The architecture stage will invent a schema, and the rest of the stages will each remember it slightly differently.');
    }
    if (!STACK_CHOICES[spec.stack.stackId]) {
      errors.push(`Unknown stack "${spec.stack.stackId}". Pick one of: ${Object.keys(STACK_CHOICES).join(', ')}`);
    }
    if (spec.stack.auth === 'none' && spec.stack.multiUser) {
      warnings.push('Multi-user data with no auth means anyone who reaches the URL can read and write everything. Pick session auth, or state that this is a trusted-network tool.');
    }
    spec.stack.seedVolume = clampInt(spec.stack.seedVolume, 0, 5000, 40);
    spec.stack.auth = AUTH_CHOICES[spec.stack.auth] ? spec.stack.auth : 'none';
    spec.stack.realtime = REALTIME_CHOICES[spec.stack.realtime] ? spec.stack.realtime : 'none';
    spec.stack.deploy = DEPLOY_CHOICES[spec.stack.deploy] ? spec.stack.deploy : 'local';
    spec.stack.tests = TEST_CHOICES[spec.stack.tests] ? spec.stack.tests : 'smoke';
  } else {
    spec.single.persistence = PERSISTENCE[spec.single.persistence] ? spec.single.persistence : 'local';
    spec.single.layout = LAYOUTS[spec.single.layout] ? spec.single.layout : 'both';
    spec.single.allowCdn = uniq((spec.single.allowCdn || []).filter((k) => CDN_LIBS[k]));
    spec.single.offlineFirst = spec.single.offlineFirst !== false;
    spec.single.keyboardShortcuts = !!spec.single.keyboardShortcuts;
    spec.single.shareData = !!spec.single.shareData;
  }

  // Cross-checks that catch the expensive mistakes before a request is spent.
  if (m === 'single-file' && /login|sign in|auth|user account|multi-?user|password/i.test(spec.idea + ' ' + spec.features.join(' '))) {
    warnings.push('The brief mentions accounts, which a single file cannot implement honestly. Either move those flows out of scope for this target, or flip the toggle to full-stack.');
  }
  if (m === 'single-file' && /postgres|mysql|mongo|prisma|sequelize|drizzle|server api/i.test(spec.idea + ' ' + spec.notes)) {
    warnings.push('A single-file target has no database. Flip the toggle, or state explicitly that data is local to the browser.');
  }
  if (m === 'full-stack' && spec.features.length > 10 && spec.ambition === 'flagship') {
    warnings.push('10+ features at flagship ambition is a multi-day project. Expect the pack to need 12+ requests; consider one flow per pack.');
  }

  if (errors.length) return { ok: false, errors, warnings, spec };
  return { ok: true, spec, warnings };
}

function normalizeEntities(raw) {
  const list = Array.isArray(raw) ? raw : asList(raw).map((line) => {
    // "Task(id, title, done:bool, due:date)" -> structured
    const m = /^([A-Za-z][\w]*)\s*\(([^)]*)\)$/.exec(line.trim());
    if (!m) return { name: line.trim(), fields: [] };
    return { name: m[1], fields: m[2].split(',').map((f) => f.trim()).filter(Boolean) };
  });
  return list.slice(0, 10).map((e) => {
    const name = asText(typeof e === 'string' ? e : e?.name);
    const fieldsRaw = typeof e === 'string' ? [] : e?.fields ?? [];
    const fields = (Array.isArray(fieldsRaw) ? fieldsRaw : []).map((f) => {
      if (typeof f === 'string') {
        const [n, t] = f.split(':');
        return { name: asText(n) || n, type: asText(t) || 'string' };
      }
      return { name: asText(f?.name), type: asText(f?.type) || 'string', note: asText(f?.note) };
    }).filter((f) => f.name);
    return { name, fields };
  }).filter((e) => e.name);
}

/** Number of records the app should ship as seed data, scaled by ambition. */
export function seedCount(spec) {
  const scale = AMBITIONS[spec.ambition].scale;
  if (spec.mode === 'full-stack') return spec.stack.seedVolume || 40;
  return Math.round(6 * scale) + (spec.entities.length ? 2 : 0);
}

/**
 * A short, testable acceptance list derived from the brief. It is echoed into the
 * plan stage and back into the audit stage: free models converge on "done" far
 * more reliably when done is a finite list than when it is an adjective.
 */
export function acceptanceCriteria(spec) {
  const base = [
    `${spec.mode === 'single-file' ? 'index.html opens from file:// with no console error' : 'npm run dev serves the client and every /api route from a clean checkout with an empty data dir'}`,
    'Every feature in the brief is reachable in the UI, not just present in code',
    'Empty, loading and error states all render from real states, with copy that says what happened',
    'Reloading preserves data; corrupt or hand-edited storage recovers instead of white-screening',
    'Full keyboard path for the primary flow; focus never disappears',
    'No TODO, placeholder, stub or "for brevity" comment anywhere in the artifact',
  ];
  if (spec.mode === 'single-file' && spec.single.persistence !== 'memory') {
    base.push('Storage is versioned and a corrupt payload still opens the app');
  }
  if (spec.mode === 'full-stack' && spec.stack.auth !== 'none') {
    base.push('Signing out invalidates the session server-side; no auth state is trusted from the client');
  }
  if (spec.mode === 'full-stack' && spec.stack.tests !== 'none') {
    base.push('The smoke test fails when a route is broken (verify by breaking one on purpose)');
  }
  if (spec.single.allowCdn?.length) {
    base.push(`Each allowed CDN library (${spec.single.allowCdn.join(', ')}) has a working no-network fallback path`);
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * Presets: the gallery in the UI, and the fixtures in the test suite.
 * ------------------------------------------------------------------ */

export const PRESETS = [
  {
    id: 'habit-garden',
    label: 'Habit garden (single file)',
    mode: 'single-file',
    spec: {
      name: 'Habit Garden',
      idea: 'A habit tracker that renders each day as a tile in a garden grid; streaks grow plants, misses wilt them. Local only, no accounts, satisfying in under 10 seconds a day.',
      audience: 'One person, on a phone, before coffee',
      ambition: 'polished',
      features: ['Add/rename/archive habits with colour and icon from a fixed set', 'Year grid: 53x7 tiles per habit, click or drag to mark a day', 'Streak, best streak, 30-day consistency %', 'Wilt/grow animation on tile state change', 'Undo for the last 20 mutations', 'Export/import the whole garden as one JSON file', 'Keyboard: arrows move, space toggles, n adds'],
      entities: [{ name: 'Habit', fields: ['id:string', 'name:string', 'color:string', 'icon:string', 'createdAt:iso-date', 'doneDates:iso-date[]', 'archived:bool'] }],
      mustHave: ['Works offline from file://', 'Dark and light theme from prefers-color-scheme', '60fps feel on a mid-range phone'],
      avoid: ['Any chart library', 'Confetti', 'Onboarding tour'],
      notes: 'The whole appeal is the grid; do not hide it behind a dashboard.',
      single: { persistence: 'local', layout: 'mobile-first', allowCdn: [], offlineFirst: true, keyboardShortcuts: true, shareData: true },
    },
  },
  {
    id: 'invoice-desk',
    label: 'Invoice desk (full stack)',
    mode: 'full-stack',
    spec: {
      name: 'Invoice Desk',
      idea: 'A two-role invoicing service: freelancers create invoices and clients pay via a magic link on a public invoice page. Real persistence, PDF-ish printable view, and a dashboard of what is outstanding.',
      audience: 'Solo freelancers with 2-20 clients',
      ambition: 'polished',
      features: ['Auth for freelancer; clients reach invoices by signed token URL', 'CRUD clients, invoices with line items, tax rate, currency', 'Invoice status: draft, sent, paid, overdue (derived from dueDate)', 'Printable invoice page with no app chrome', 'Dashboard: outstanding total, overdue list, this-month income', 'Numbered invoice sequence that never reuses a number'],
      entities: [
        { name: 'Client', fields: ['id:string', 'name:string', 'email:string', 'address:text'] },
        { name: 'Invoice', fields: ['id:string', 'number:string', 'clientId:string', 'status:enum', 'dueDate:date', 'taxPercent:number', 'currency:string'] },
        { name: 'LineItem', fields: ['id:string', 'invoiceId:string', 'description:string', 'qty:number', 'unitPrice:number'] },
      ],
      mustHave: ['Money as integer minor units, never floats', 'Signed token URLs with expiry', 'Idempotent seed script'],
      avoid: ['Stripe integration', 'Email sending (write the seam, log the message)', 'Multi-tenant teams'],
      notes: 'Single freelancer per deploy; no org table.',
      stack: { stackId: 'node-express-postgres', auth: 'session', realtime: 'none', deploy: 'render', tests: 'smoke', seedVolume: 60, multiUser: false },
    },
  },
  {
    id: 'forge-zero',
    label: 'Forge-Zero itself (full stack)',
    mode: 'full-stack',
    spec: {
      name: 'Forge-Zero',
      idea: 'A prompt-generation workbench that turns a short app idea into a staged prompt pack, with a toggle between single-file HTML and full-stack targets, and prompt budgets fitted to the ceilings of free-tier LLM API keys.',
      audience: 'Developers driving free models through an API key',
      ambition: 'flagship',
      features: ['Mode toggle that swaps the entire blueprint, not just a label', 'Brief editor with features, entities and constraints', 'Model catalogue with context, output ceiling and free-tier limits', 'Token fit analysis with warnings and automatic stage re-splitting', 'Stage list with copy, export, and per-stage budget meters', 'Server-side key storage with a rate governor so the daily quota is never exceeded', 'Repair loop: paste a failure, get a patch prompt', 'Saved projects'],
      entities: [
        { name: 'Project', fields: ['id:uuid', 'name:string', 'mode:enum', 'specJson:json', 'createdAt:ts', 'updatedAt:ts'] },
        { name: 'PromptPack', fields: ['id:uuid', 'projectId:uuid', 'modelId:string', 'strategy:enum', 'packJson:json'] },
        { name: 'Run', fields: ['id:uuid', 'packId:uuid', 'stageId:string', 'modelId:string', 'status:enum', 'inTokens:int', 'outTokens:int', 'ms:int', 'error:text'] },
      ],
      mustHave: ['Zero runtime dependencies beyond express', 'Keys never leave the server, masked in all responses', 'Offline-capable: the pack needs no network to compose'],
      avoid: ['ORM', 'React', 'Docker'],
      notes: 'node:sqlite for storage; SSE for streaming generated code into a sandboxed preview.',
      stack: { stackId: 'node-express-sqlite', auth: 'none', realtime: 'sse', deploy: 'local', tests: 'smoke', seedVolume: 25, multiUser: false },
    },
  },
  {
    id: 'focus-timer',
    label: 'Focus timer (single file, MVP)',
    mode: 'single-file',
    spec: {
      name: 'One-Tab Focus Timer',
      idea: 'A pomodoro timer for exactly one task: type what you are doing, start the ring, and the session appends to today\'s log. Nothing else.',
      audience: 'Anyone with two tabs open',
      ambition: 'mvp',
      features: ['Task input, 25/5 ring timer with pause and skip', 'Today list of completed sessions with total focus minutes', 'Web Notification when a timer ends, asked for once', 'Persist across reload and correct itself if the tab slept'],
      entities: [{ name: 'Session', fields: ['id:string', 'task:string', 'startedAt:iso-date', 'minutes:number', 'completed:bool'] }],
      mustHave: ['Monospace-ish timer numerals', 'No framework'],
      avoid: ['Projects, tags, stats pages, sounds'],
      notes: 'Keep it under 300 lines.',
      single: { persistence: 'local', layout: 'desktop-first', allowCdn: [], offlineFirst: true, keyboardShortcuts: false, shareData: false },
    },
  },
  {
    id: 'team-status',
    label: 'Team status board (full stack, MVP)',
    mode: 'full-stack',
    spec: {
      name: 'Standup Board',
      idea: 'An async standup tool: each person posts yesterday, today and blockers on a per-day board; the team lead sees an unresolved-blocker digest.',
      audience: 'A single 4-12 person remote team',
      ambition: 'mvp',
      features: ['Email login with a 4-digit code (no passwords)', 'Daily board with per-person entry, edit until midnight', 'Blocker flag with resolve toggle and an open-blockers list', 'Digest view grouped by person for a chosen week'],
      entities: [
        { name: 'Person', fields: ['id:string', 'email:string', 'displayName:string'] },
        { name: 'Entry', fields: ['id:string', 'personId:string', 'day:date', 'yesterday:text', 'today:text', 'blocker:text', 'resolved:bool'] },
      ],
      mustHave: ['Server-side day boundary in UTC', 'Rate limit the code request route'],
      avoid: ['Realtime websockets', 'Avatars', 'Slack integration'],
      notes: 'Code "delivery" is logged to the console; no SMTP.',
      stack: { stackId: 'node-express-sqlite', auth: 'session', realtime: 'none', deploy: 'local', tests: 'smoke', seedVolume: 30, multiUser: true },
    },
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}
