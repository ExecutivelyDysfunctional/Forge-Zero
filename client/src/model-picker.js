/**
 * Model picker dialog. The whole premise of the tool is that the target model
 * changes the prompt, so choosing it has to show the numbers that matter -
 * output ceiling, context, daily requests, and the fit - not just a name.
 */
import { api } from './api.js';
import { h, fmt, chip, toast } from './ui.js';
import { state, setModel } from './state.js';

export function openModelPicker() {
  const dlg = h('dialog', {},
    h('header', {},
      h('h2', { style: 'font:600 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim)', text: 'Target free model' }),
      h('span.sp'),
      h('button.btn.xs', { onclick: () => autoPick(dlg), text: 'auto-pick best' }),
      h('button.btn.xs.ghost', { onclick: () => dlg.close(), text: 'close' })),
    h('div.modal-body'));

  const body = dlg.querySelector('.modal-body');
  let recommendation = null;

  const paint = (ranked = null) => {
    body.textContent = '';
    const groups = state.boot?.models ?? [];
    const rankOf = new Map((ranked ?? []).map((r) => [r.modelId, r]));
    for (const g of groups) {
      body.append(
        h('div.section-title', {}, `${g.label} `, chip(g.provider === 'ollama' ? 'no key needed' : 'free tier', 'plain')),
        h('div.hint', { style: 'margin-bottom:6px', text: g.tierNote }),
        h('div.model-table', {}, ...g.models.map((m) => row(m, g, rankOf.get(m.id))))
      );
    }
    body.append(h('div.hint', { style: 'margin-top:12px', text: state.boot?.catalog?.verifiedAt ? `Catalogue limits verified ${state.boot.catalog.verifiedAt}. Free tiers move; when a number here disagrees with the provider console, the console is right - edit server/lib/catalog.js.` : '' }));
  };

  const row = (m, g, rank) => {
    const fit = rank?.fit ? chip(rank.fit, rank.fit === 'comfortable' ? 'good' : rank.fit === 'tight' ? 'warn' : 'bad') : null;
    return h('button.model-row', {
      class: 'model-row' + (m.id === state.modelId ? ' sel' : ''),
      onclick: () => { setModel(m.id); toast(`Prompt pack recomposed for ${m.label}`, 'ok'); dlg.close(); },
    },
      h('span.nm', {}, h('span', { text: m.label }), h('small', { text: m.id })),
      h('span.cell', { text: fmt.tokens(m.outputCeiling), title: 'max output tokens per response' }),
      h('span.cell', { text: fmt.tokens(m.contextWindow), title: 'context window' }),
      h('span.cell', { text: m.freeTier?.rpd ? fmt.tokens(m.freeTier.rpd) : '∞', title: 'free requests/day' }),
      h('span.cell', { text: String(m.quality), title: 'coding quality (engine score, 0-10)' }),
      h('span.row', { style: 'gap:4px' }, fit, (m.quirks?.length ?? 0) ? chip(m.quirks.length + ' quirks', 'plain') : null));
  };

  if (state.spec) {
    api.post('/api/models/recommend', { mode: state.mode, spec: state.spec, modelId: state.modelId })
      .then((r) => { recommendation = r; paint(r.ranked); })
      .catch(() => paint());
  } else {
    paint();
  }

  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
}

async function autoPick(dlg) {
  const r = await api.post('/api/models/recommend', { mode: state.mode, spec: state.spec, modelId: state.modelId });
  if (!r?.suggestedModelId) return toast('No recommendation available', 'err');
  setModel(r.suggestedModelId);
  const label = r.ranked.find((x) => x.modelId === r.suggestedModelId)?.label ?? r.suggestedModelId;
  toast(`Switched to ${label} — best fit for this brief on a free tier`, 'ok');
  dlg.close();
}
