/**
 * Right rail: the "can this actually run on my free key" console.
 *
 * This panel is the honest half of the product. The pack in the middle is only
 * correct if the budget arithmetic holds, so every gauge, warning and applied
 * optimisation is visible here, with one-click fixes that mutate the brief and
 * recompose rather than telling the user to go edit something.
 */
import { api } from './api.js';
import { h, fmt, chip, copyText, toast, gauge } from './ui.js';
import { state, setSpec, setOption, models, loadKeys, loadRuns } from './state.js';
import { openModelPicker } from './model-picker.js';

export function renderRail(host) {
  host.textContent = '';
  const pack = state.pack;
  host.append(
    pack ? budgetPanel(pack) : h('div.panel', {}, h('header', {}, h('h2', { text: 'Fit & budget' })), h('div.panel-body', {}, h('div.hint', { text: 'Compose a pack to measure it against the model ceilings.' }))),
    pack ? warningsPanel(pack) : null,
    pack?.optimizations?.length ? optimizationsPanel(pack) : null,
    modelPanel(),
    repairPanel(),
    keysPanel(),
    runsPanel()
  );
}

function budgetPanel(pack) {
  const b = pack.budget;
  const m = pack.model;
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Fit & budget' }), h('span.sp'), b.fits ? chip('executable', 'good') : chip('blocked', 'bad')),
    h('div.panel-body.tight', {},
      gauge('output ceiling / stage', b.ceilingUtilPct, 100, { kind: b.ceilingUtilPct > 82 ? 'bad' : b.ceilingUtilPct > 70 ? 'warn' : 'quench', note: `${fmt.tokens(b.perStageTokens)} of ${fmt.tokens(m.outputCeiling)} (plan ≤ 82%)` }),
      gauge('context per stage', b.contextPct, 100, { kind: b.contextPct > 78 ? 'warn' : 'quench', note: `${b.contextPct}% of ${fmt.tokens(m.contextWindow)}` }),
      gauge('daily requests', b.rpdPct ?? 0, 100, { kind: (b.rpdPct ?? 0) > 100 ? 'bad' : (b.rpdPct ?? 0) > 45 ? 'warn' : 'quench', note: b.rpdPct == null ? 'no published cap' : `~${b.projectedRequests} of ${m.freeTier?.rpd} req` }),
      gauge('daily tokens', b.tpdPct ?? 0, 100, { kind: (b.tpdPct ?? 0) > 100 ? 'bad' : 'quench', note: b.tpdPct == null ? 'no published cap' : `~${fmt.tokens(b.projectedTokens)} of ${fmt.tokens(m.freeTier?.tpd)}` }),
      h('div.meta-grid', {},
        box('parts', b.parts),
        box('artifact', `${fmt.tokens(pack.sizeBudget.tokens)}`),
        box('lines', pack.sizeBudget.lines),
        box('ETA', `${b.etaMinutes} min`),
        box('spacing', `${b.minSpacingSec}s`),
        box('repairs', `${Math.max(1, Math.round(b.parts * 0.6))}`))),
    h('div.hint', { text: 'ETA is the larger of “tokens ÷ TPM” and “tokens ÷ model speed”: on a free key the per-minute allowance, not the model, is usually what sets how long a build takes.' }));

  function box(k, v) { return h('div.meta', {}, h('div.k', { text: k }), h('div.v', { text: String(v) })); }
}

function warningsPanel(pack) {
  const items = pack.budget.warnings ?? [];
  const brief = (pack.briefWarnings ?? []).map((wtext) => h('div.warning.info', {}, h('div.t', { text: 'Brief' }), h('div.d', { text: wtext })));
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Warnings' }), h('span.sp'), items.length ? chip(String(items.length), items.some((w) => w.severity === 'block') ? 'bad' : 'warn') : chip('clean', 'good')),
    h('div.panel-body.tight', {},
      ...(items.length || brief.length ? [...brief, ...items.map((w) => warningCard(w, pack))] : [h('div.hint', { text: 'Nothing exceeds a ceiling or a daily allowance for this model and size.' })])));
}

function warningCard(w, pack) {
  return h('div.warning' + (w.severity === 'block' ? '.block' : w.severity === 'warn' ? '.warn' : '.info'), {},
    h('div.row', {}, chip(w.severity, w.severity === 'block' ? 'bad' : w.severity === 'warn' ? 'warn' : 'plain'), h('div.t', { text: w.title })),
    h('div.d', { text: w.detail }),
    w.fixes?.length ? h('div.fixes', {}, ...w.fixes.map((f) => h('button.btn.xs', { onclick: () => applyFix(f, pack), text: '⚙ ' + f.label }))) : null);
}

/**
 * Warning fixes act on the real inputs of the pack - the brief, the options, the
 * model - so the recommendation is executable instead of advisory.
 */
async function applyFix(f, pack) {
  switch (f.action) {
    case 'increase-parts':
      setOption('strategy', 'staged');
      toast('Forced staged execution and re-fit every stage', 'ok');
      break;
    case 'compact-constitution':
      setOption('compactRules', 'always');
      toast('Contract compressed to the core rules', 'ok');
      break;
    case 'drop-stage':
      setOption('includeAudit', false);
      toast('Audit stage dropped — re-enable it if the first run misbehaves', 'ok');
      break;
    case 'set-ambition':
      setSpec({ ambition: f.params.ambition });
      toast(`Ambition set to ${f.params.ambition}`, 'ok');
      break;
    case 'set-model': {
      const found = models.flat().find((m) => m.id === f.params.modelId);
      if (found) {
        state.modelId = found.id;
        toast(`Target switched to ${found.label}`, 'ok');
        import('./state.js').then((S) => S.composeNow());
      } else openModelPicker();
      break;
    }
    case 'reduce-features':
      setSpec({ features: (pack.spec.features ?? []).slice(0, 4) });
      toast('Kept the first four features; the rest are yours to re-add later', 'ok');
      break;
    case 'open-catalog':
      window.open('https://github.com/ExecutivelyDysfunctional/Forge-Zero/blob/main/server/lib/catalog.js', '_blank', 'noopener');
      break;
    default:
      toast('No automatic fix for that one', '');
  }
}

function optimizationsPanel(pack) {
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Optimisations applied' }), h('span.sp'), chip(String(pack.optimizations.length), 'good')),
    h('div.panel-body.tight', {},
      ...pack.optimizations.map((o) => h('div.opt-item', {},
        h('div.t', { text: o.title }),
        h('div.d', { text: o.detail }),
        o.triggeredBy ? h('div.src', { text: 'triggered by ' + o.triggeredBy }) : null))));
}

function modelPanel() {
  const m = models.byId(state.modelId) ?? {};
  const boot = state.boot;
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Target model' }), h('span.sp'),
      h('button.btn.xs.ghost', { onclick: openModelPicker, text: 'change' })),
    h('div.panel-body.tight', {},
      h('div', {}, h('div', { style: 'font-weight:600', text: m.label ?? state.modelId }),
        h('div.hint.mono', { text: m.id ?? '—' })),
      h('div.meta-grid', {},
        kv('output', fmt.tokens(m.outputCeiling) + '/resp'),
        kv('context', fmt.tokens(m.contextWindow)),
        kv('quality', String(m.quality ?? '—')),
        kv('speed', (m.speedTps ?? '—') + ' t/s'),
        kv('rpm', m.freeTier?.rpm ?? '—'),
        kv('rpd', m.freeTier?.rpd ?? '—')),
      m.quirks?.length ? h('div', {}, h('div.lbl', { text: 'Failure modes this prompt defends against' }),
        h('div', { style: 'display:grid;gap:5px;margin-top:5px' }, ...m.quirks.map((q) => h('div.quirk', {}, h('span', { text: '·' }), h('span', {}, h('b', { text: q }), ' — ', quirkText(q, boot))))) ) : null,
      h('div.divider'),
      h('div.hint', { text: m.tierNote ?? '' }),
      h('div.row', {},
        chip(m.providerLabel ?? '', 'plain'),
        m.keyUrl ? h('a.btn.xs.ghost', { href: m.keyUrl, target: '_blank', rel: 'noopener', text: 'get a free key ↗' }) : null,
        h('button.btn.xs.ghost', { onclick: autoFit, text: 'auto-pick' }))));

  function kv(k, v) { return h('div.meta', {}, h('div.k', { text: k }), h('div.v', { text: String(v) })); }
}

const QUIRK_TEXT = {
  preamble: 'forces a hard "no prose" lock',
  truncation: 'sizes every stage under the ceiling and arms CONTINUE',
  'markdown-creep': 'bans code fences so files can be reassembled',
  'reasoning-tax': 'reserves output tokens and forbids narrated thinking',
  drift: 'restates the contract at the end of each prompt',
  terse: 'adds a completeness floor and keeps the audit stage',
  'over-abstract': 'locks structure to plain functions',
  'hallucinated-api': 'pins libraries and bans unlisted imports',
  'unicode-wobble': 'forces ASCII output',
  'summary-addict': 'bans describing changes instead of emitting them',
  'self-consistent': 'enables the checklist self-review',
  'fast-cheap': 'allows a bigger plan per day',
};
const quirkText = (q) => QUIRK_TEXT[q] ?? 'custom handling applied';

async function autoFit() {
  const r = await api.post('/api/models/recommend', { mode: state.mode, spec: state.spec, modelId: state.modelId });
  const cur = r.current;
  state.autoFit = r;
  toast(`Best fit: ${r.ranked[0]?.label ?? '—'}${cur?.fit ? ` (current: ${cur.fit})` : ''}`, 'ok');
  import('./state.js').then((S) => S.composeNow());
}

function repairPanel() {
  const ui = (state.ui.repair ??= { failure: '', result: null, stage: '' });
  const stageIds = (state.pack?.stages ?? []).map((s) => s.id);
  const ta = h('textarea.mono', { rows: 4, value: ui.failure, placeholder: 'Paste the console error / stack trace from the generated app…', oninput: (e) => { ui.failure = e.target.value; } });
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Repair loop' }), h('span.sp'), chip('failure → patch prompt', 'melt')),
    h('div.panel-body.tight', {},
      h('div.hint', { text: 'A free model fixes its own output far better than you can prompt it to be perfect first time. Paste the failure; get a bounded, injection-safe repair prompt for the exact stage.' }),
      h('select', { onchange: (e) => { ui.stage = e.target.value; } },
        h('option', { value: '', text: 'stage: auto (last run)' }),
        ...stageIds.map((s) => h('option', { value: s, selected: ui.stage === s, text: s }))),
      ta,
      h('div.row', {},
        h('button.btn.sm', { onclick: () => buildRepair(ta.value, ui.stage), text: 'build repair prompt' }),
        ui.result ? h('button.btn.xs', { onclick: () => copyText(ui.result.prompt.system + '\n\n' + ui.result.prompt.user).then((ok) => ok && toast('Repair prompt copied', 'ok')), text: '⧉ copy' }) : null),
      ui.result ? h('div', {},
        h('pre.prompt', { style: 'max-height:260px', text: ui.result.prompt.user.slice(0, 4000) }),
        h('div.hint', { text: `temperature 0 · max_tokens ${ui.result.prompt.params.max_tokens}${ui.result.meta.truncatedOutput ? ' · stage output was windowed to protect the context budget' : ''}` })) : null));
}

async function buildRepair(failure, stageId) {
  const pack = state.pack;
  if (!pack) return toast('Compose a pack first', 'err');
  const stage = pack.stages.find((s2) => s2.id === stageId) ?? pack.stages.at(-1);
  // Prefer the output this workbench just streamed; fall back to whatever the
  // user pasted alongside the error. Either way the server windows it.
  const stageOutput = state.ui.stages?.[stage.id]?.out ?? '';
  state.ui.repair = { failure, result: null, stage: stage.id };
  const r = await api.repair({
    stageTitle: stage.title, failure, stageOutput,
    modelId: pack.model.id, mode: pack.mode, files: stage.files ?? [], attempt: 2,
  });
  state.ui.repair.result = r;
  renderRail(document.getElementById('rail-right'));
}

function keysPanel() {
  const providers = state.boot?.providers ?? [];
  const keys = state.keys ?? [];
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Free-tier keys' }), h('span.sp'),
      h('button.btn.xs.ghost', { onclick: async () => { await loadKeys(); await loadRuns(); renderRail(document.getElementById('rail-right')); }, text: '↻ refresh' })),
    h('div.panel-body.tight', {},
      h('div.hint', { text: 'Keys are encrypted with AES-256-GCM before they reach SQLite, and the browser only ever sees a mask. All calls are proxied server-side through the rate governor.' }),
      ...providers.map((p) => providerRow(p, keys.find((k) => k.provider === p.id)))));

  function providerRow(p, k) {
    const ui = (state.ui.keys ??= {});
    const st = ui[p.id] ??= { value: '', busy: false, result: null };
    const input = h('input', { type: 'password', placeholder: k?.configured ? 'replaces stored key' : `${p.label} API key`, value: st.value, oninput: (e) => { st.value = e.target.value; } });
    const modelId = (state.boot?.models?.find((g) => g.provider === p.id)?.models?.[0]?.id);
    return h('div', { style: 'display:grid;gap:6px;padding:8px 0;border-bottom:1px solid var(--line)' },
      h('div.row', {},
        h('span', { style: 'font-weight:600;font-size:12.5px;flex:1', text: p.label }),
        k?.configured ? chip(k.fromEnv ? 'from env' : 'stored', 'good') : chip('none', 'plain'),
        k?.masked ? h('span.mono', { style: 'font-size:11px;color:var(--ink-mute)', text: k.masked }) : null),
      h('div.row', { style: 'gap:6px' }, input,
        h('button.btn.xs', {
          disabled: st.busy,
          onclick: async () => {
            if (!st.value.trim()) return toast('Paste a key first', 'err');
            st.busy = true; renderRail(document.getElementById('rail-right'));
            try { await api.saveKey(p.id, st.value.trim()); st.value = ''; await loadKeys(); toast(`${p.label} key stored (encrypted)`, 'ok'); }
            catch (err) { toast(err.message, 'err'); }
            st.busy = false; renderRail(document.getElementById('rail-right'));
          }, text: 'store' }),
        h('button.btn.xs.ghost', {
          onclick: async () => {
            st.result = { busy: true };
            try { const r = await api.testKey(p.id, modelId); st.result = r; toast(r.ok ? `${p.label}: ${r.message}` : `${p.label}: ${r.message}`, r.ok ? 'ok' : 'err'); }
            catch (err) { st.result = { ok: false, message: err.message }; toast(err.message, 'err'); }
            renderRail(document.getElementById('rail-right'));
          }, text: 'test' }),
        k?.configured && !k.fromEnv ? h('button.btn.xs.ghost', { onclick: async () => { await api.deleteKey(p.id); await loadKeys(); renderRail(document.getElementById('rail-right')); }, text: 'drop' }) : null),
      h('div.hint', { text: (p.envVarNames?.[0] ? `env: ${p.envVarNames[0]} · ` : '') + (p.needsKey ? '' : 'no key required · ') + `free keys: ${p.label}` }),
      st.result && !st.result.busy ? h('div.hint', { style: st.result.ok ? 'color:var(--quench)' : 'color:var(--danger)', text: st.result.message ?? '' }) : null,
      h('div.hint', { text: p.tierNote }));
  }
}

function runsPanel() {
  const runs = state.runs ?? [];
  const items = runs.length
    ? [h('ul.list-plain', {},
        ...runs.slice(0, 8).map((r) => h('li', {},
          h('div.row', {},
            chip(r.status, r.status === 'ok' ? 'good' : r.status === 'running' ? 'melt' : 'bad'),
            h('span', { style: 'flex:1;min-width:0;font-size:12px', text: r.stage_key ?? '—' })),
          h('div.sub', { text: `${r.model_id} · ${fmt.tokens(r.output_tokens)} out · ${fmt.ms(r.ms)} · ${fmt.ago(r.created_at)}${r.error ? ' · ' + String(r.error).slice(0, 90) : ''}` }))))]
    : [h('div.hint', { text: 'No runs recorded yet. Stages executed here are logged with token counts so quota use stays auditable after the fact.' })];
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Run log' }), h('span.sp'), chip(String(runs.length), 'plain')),
    h('div.panel-body.tight', {},
      ...items,
      h('button.btn.xs.ghost', { onclick: async () => { await loadRuns(); renderRail(document.getElementById('rail-right')); }, text: '↻ reload log' })));
}
