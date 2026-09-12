/**
 * Workbench bootstrap and top-level render loop.
 *
 * Four regions, one store, four render functions. State changes emit a reason and
 * each region repaints only itself; the alternative - a full re-render on every
 * keystroke - is what makes hand-rolled UIs lose focus and caret position.
 */
import { h, fmt, chip, toast } from './ui.js';
import { state, subscribe, loadBoot, setMode, models, saveProject } from './state.js';
import { renderBrief } from './brief.js';
import { renderPack } from './pack.js';
import { renderRail } from './rail.js';
import { openModelPicker } from './model-picker.js';

const regions = {
  rail: document.getElementById('rail'),
  center: document.getElementById('center'),
  railRight: document.getElementById('rail-right'),
  topbar: document.getElementById('topbar-extra'),
};

renderTopbar();
subscribe(render);

// Reasons that legitimately rebuild the brief panel. Composition results are not
// among them: repainting the form 400ms after a keystroke would steal the caret.
const REBRIEF_REASONS = new Set(['boot', 'mode', 'preset', 'reset', 'spec:shape', 'options', 'project', 'saved']);

function render(reason = 'update') {
  renderTopbar();
  // Re-rendering the brief on every keystroke would blow away focus and the caret;
  // only structural changes (mode, list shape, preset, pack swap) rebuild it.
  if (REBRIEF_REASONS.has(reason) || !regions.rail.childElementCount) renderBrief(regions.rail);
  renderPack(regions.center);
  renderRail(regions.railRight);
}

function renderTopbar() {
  const host = regions.topbar;
  if (!host) return;
  const mode = state.mode;
  const toggle = h('div.toggle', { role: 'radiogroup', 'aria-label': 'Target output complexity' });
  const options = [
    { id: 'single-file', icon: '▤', label: 'Single-file HTML', meta: 'one index.html · no build · no server' },
    { id: 'full-stack', icon: '⛁', label: 'Full-stack app', meta: 'server · db · client · staged' },
  ];
  const buttons = options.map((o) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(o.id === mode), title: o.meta,
    onclick: () => setMode(o.id),
  }, h('span.tg-ico', { text: o.icon }), h('span.toggle-meta', {}, h('span', { text: o.label }), h('small', { text: o.meta }))));
  toggle.append(...buttons);
  const idx = options.findIndex((o) => o.id === mode);
  requestAnimationFrame(() => {
    const w = buttons[idx]?.offsetWidth || 0;
    toggle.style.setProperty('--thumb-w', w + 'px');
    toggle.style.setProperty('--thumb-x', (idx === 0 ? 0 : (buttons[0]?.offsetWidth ?? 0) - w + 2) + 'px');
  });

  const m = models.byId(state.modelId);
  const key = models.keyState(state.modelId);
  host.textContent = '';
  host.append(
    toggle,
    h('div.modelpick', {},
      h('button.modelpick-btn', { onclick: openModelPicker, title: 'Change the target free model — the whole pack is re-fit' },
        h('span.m-label', { text: m?.label ?? state.modelId }),
        h('span.m-lim', { text: m ? `${fmt.tokens(m.outputCeiling)}↑ ${fmt.tokens(m.contextWindow)}ctx ${m.freeTier?.rpd ? fmt.tokens(m.freeTier.rpd) + '/d' : 'no cap'}` : '' })),
      key?.configured ? chip('key', 'good') : chip('no key', 'warn')),
    h('button.btn.sm.ghost', { onclick: () => saveProject(), text: 'save' }),
    h('button.btn.sm.ghost', { onclick: openBlueprintDialog, text: 'blueprint' })
  );
}

/**
 * Transparency dialog: the rules and protocols a composed pack is made of, with
 * the reason each exists. A prompt tool that will not show its own contract is
 * just a template dump.
 */
function openBlueprintDialog() {
  const b = state.boot ?? {};
  const modeDef = (b.modes ?? []).find((m) => m.id === state.mode);
  const dlg = h('dialog', {},
    h('header', {},
      h('h2', { style: 'font:600 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim)', text: `Blueprint — ${modeDef?.label ?? state.mode}` }),
      h('span.sp'),
      h('div.seg', {}, ...['rules', 'stages', 'protocols'].map((t, i) => {
        const btn = h('button', { 'aria-pressed': String(i === 0), onclick: (e) => { e.currentTarget.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); paint(t); }, text: t });
        return btn;
      })),
      h('button.btn.xs.ghost', { onclick: () => dlg.close(), text: 'close' })),
    h('div.modal-body'));
  const body = dlg.querySelector('.modal-body');
  const paint = (tab) => {
    body.textContent = '';
    if (tab === 'rules') {
      body.append(h('div.hint', { text: 'The behaviour contract every stage inherits. Core rules are always sent; extended rules are only sent when the model has the context to actually obey them.' }),
        ...(b.constitution ?? []).map((r) => h('div', { style: 'padding:9px 0;border-bottom:1px solid var(--line)' },
          h('div.row', {}, chip(r.weight === 'core' ? 'core' : 'extended', r.weight === 'core' ? 'melt' : 'plain'), chip(r.applies, 'plain'), h('b', { text: r.title })),
          h('div.hint', { text: r.preview + (r.preview.length >= 90 ? '…' : '') }))));
    } else if (tab === 'stages') {
      body.append(...(modeDef?.stages ?? []).map((s) => h('div', { style: 'padding:9px 0;border-bottom:1px solid var(--line)' },
        h('div.row', {}, chip(s.kind, s.kind === 'plan' ? 'melt' : 'plain'), s.maxLines ? chip(`≤${s.maxLines} lines`, 'plain') : null, h('b', { text: s.title })),
        h('div.hint', { text: s.purpose }))));
      body.append(h('div.hint', { style: 'margin-top:10px', text: 'Repeatable stages (routes, views) are expanded into one stage per chunk, sized from the selected model output ceiling — this list shows the templates before chunking.' }));
    } else {
      const p = b.protocols ?? {};
      body.append(
        h('div.section-title', { text: 'output protocol (in every system prompt)' }), h('pre.prompt', { text: p.output ?? '' }),
        h('div.section-title', { text: 'continuation' }), h('pre.prompt', { text: p.continue ?? '' }),
        h('div.section-title', { text: 'repair' }), h('pre.prompt', { text: p.repair ?? '' }));
    }
  };
  paint('rules');
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
}

function renderStatusLine() {
  let el = document.getElementById('statusline');
  if (!el) { el = h('div', { id: 'statusline', class: 'sr-live status', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  const pack = state.pack;
  el.textContent = state.error ? `brief incomplete: ${state.error}`
    : pack ? `${pack.modeLabel} · ${pack.model.label} · ${pack.strategy} · ${pack.stageCount} stages · ${pack.budget.fits ? 'fits' : 'blocked'}`
    : 'idle';
}

const unwatch = subscribe(renderStatusLine);
void unwatch;

loadBoot().catch((err) => {
  toast(`Could not reach the Forge-Zero API: ${err.message}`, 'err');
  regions.center.append(h('div.empty-state', {}, h('h3', { text: 'API unreachable' }), h('p', { text: err.message })));
});
