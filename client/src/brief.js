/**
 * The brief panel: everything the model is told about the idea.
 *
 * Structure only re-renders when the *shape* changes (mode, list length,
 * ambition); typing into a field writes straight to state. Re-rendering focused
 * inputs on every keystroke is the classic way a hand-rolled UI becomes unusable.
 */
import { h, fmt, chip } from './ui.js';
import { state, setSpec, setSpecSection, setMode, setOption, applyPreset, newBrief, saveProject, openProject, deleteProject, models } from './state.js';

const field = (label, input, hint) => h('label.f', {}, h('span', { text: label }), input, hint ? h('div.hint', { text: hint }) : null);

export function renderBrief(host) {
  const spec = state.spec;
  if (!spec) return;
  const mode = state.mode;
  host.textContent = '';

  host.append(
    presetPanel(),
    h('section.panel', {},
      h('header', {}, h('h2', { text: 'Brief' }), h('span.sp'), h('button.mini', { title: 'Clear the brief', onclick: newBrief, text: '×' })),
      h('div.panel-body.tight', {},
        field('Project name', input('name', spec.name, 'Invoice Desk'), 'Used for the file name in exports.'),
        field('What is it, and what is the hard part?',
          h('textarea.mono', { rows: 5, value: spec.idea, oninput: (e) => setSpec({ idea: e.target.value }, 'spec:text'), placeholder: 'A habit tracker that renders each day as a tile in a year grid…' }),
          'One or two sentences. Name the mechanic that makes it not-trivial - that is what the model will otherwise flatten.'),
        field('Who uses it', input('audience', spec.audience, 'Solo auditors, on a phone')),
        h('div.grid2', {},
          field('Ambition', segmented('ambition', ['mvp', 'polished', 'flagship'], spec.ambition, (v) => setSpec({ ambition: v }, 'ambition'), (v) => state.boot?.ambitions?.[v]?.label ?? fmt.title(v))),
          field('Target complexity', segmented('mode', ['single-file', 'full-stack'], mode, setMode, (v) => state.boot?.modes?.find((m) => m.id === v)?.label ?? v))),
      )),

    listPanel('Features', spec.features, 'features', 'One feature per line, verb-first: "Export the month as CSV"'),
    entityPanel(spec),
    h('section.panel', {},
      h('header', {}, h('h2', { text: 'Constraints' })),
      h('div.panel-body.tight', {},
        field('Non-negotiables', h('textarea', { rows: 2, value: (spec.mustHave ?? []).join('\n'), oninput: (e) => setSpec({ mustHave: lines(e.target.value) }, 'spec:text'), placeholder: 'Money as integer cents\nNo external fonts' })),
        field('Explicitly out of scope', h('textarea', { rows: 2, value: (spec.avoid ?? []).join('\n'), oninput: (e) => setSpec({ avoid: lines(e.target.value) }, 'spec:text'), placeholder: 'No confetti\nNo onboarding tour' })),
        field('Notes for the model', h('textarea', { rows: 2, value: spec.notes, oninput: (e) => setSpec({ notes: e.target.value }, 'spec:text'), placeholder: 'Anything a reasonable engineer would get wrong.' })))),

    modePanel(mode, spec),
    optionsPanel(),
    projectPanel()
  );
}

function presetPanel() {
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Start from' })),
    h('div.panel-body.tight', {},
      h('select', {
        onchange: (e) => { if (e.target.value) applyPreset(e.target.value); e.target.value = ''; },
      },
        h('option', { value: '', text: 'Pick an example brief…' }),
        ...(state.boot?.presets ?? []).map((p) => h('option', { value: p.id, text: `${p.label} — ${p.mode === 'full-stack' ? 'full-stack' : 'single file'}` }))
      ),
      h('div.hint', { text: 'Examples exist to show what the toggle does to the same idea: the stage plan, the ceilings and the rule set all change.' })));
}

function listPanel(title, items, key, placeholder) {
  const list = Array.isArray(items) ? items : [];
  const row = (value, i) => h('div.row', {},
    h('input', {
      type: 'text', value, placeholder: i === 0 ? placeholder : '',
      oninput: (e) => { const next = [...list]; next[i] = e.target.value; setSpec({ [key]: next }, 'spec:list'); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); setSpec({ [key]: [...list.slice(0, i + 1), '', ...list.slice(i + 1)] }, 'spec:shape'); } },
    }),
    h('button.mini', { title: 'Move up', disabled: i === 0, onclick: () => move(list, i, -1, key), text: '↑' }),
    h('button.mini', { title: 'Remove', onclick: () => setSpec({ [key]: list.filter((_, j) => j !== i) }, 'spec:shape'), text: '×' }));

  return h('section.panel', {},
    h('header', {}, h('h2', { text: title }), h('span.chip', { text: String(list.length) })),
    h('div.panel-body.tight', {},
      h('div.list-edit', {}, list.length ? list.map(row) : h('div.hint', { text: 'Nothing yet — the model will invent features and pick the shortest version of each.' })),
      h('button.btn.sm.ghost', { onclick: () => setSpec({ [key]: [...list, ''] }, 'spec:shape'), text: '+ Add ' + key.replace(/([A-Z])/g, ' $1').toLowerCase() })));
}

function move(list, i, dir, key) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  setSpec({ [key]: next }, 'spec:shape');
}

function entityPanel(spec) {
  const entities = spec.entities ?? [];
  const rows = entities.map((e, i) => h('div', { style: 'display:grid;gap:5px' },
    h('div.row', {},
      h('input', { type: 'text', value: e.name ?? '', placeholder: 'Invoice', oninput: (ev) => editEntity(i, { name: ev.target.value }) }),
      h('button.mini', { text: '×', onclick: () => setSpec({ entities: entities.filter((_, j) => j !== i) }, 'spec:shape') })),
    h('input', { type: 'text', value: (e.fields ?? []).map((f) => `${f.name}:${f.type}`).join(', '), placeholder: 'id:string, total:number, due:date', oninput: (ev) => editEntity(i, { fields: parseFields(ev.target.value) }) })));

  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Data model' }), chip(state.mode === 'full-stack' ? 'drives schema' : 'drives state', 'melt')),
    h('div.panel-body.tight', {},
      ...(rows.length ? rows : [h('div.hint', { text: state.mode === 'full-stack'
        ? 'Declare the tables here or the architecture stage invents them - and every later stage remembers them slightly differently.'
        : 'Optional for a single file: it becomes the shape of the state object and of localStorage.' })]),
      h('button.btn.sm.ghost', {
        onclick: () => setSpec({ entities: [...entities, { name: '', fields: [] }] }, 'spec:shape'), text: '+ Add entity' })));

  function editEntity(i, patch) {
    const next = entities.map((e, j) => (j === i ? { ...e, ...patch } : e));
    setSpec({ entities: next }, 'spec:shape');
  }
}

function parseFields(text) {
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((f) => {
    const [name, type] = f.split(':');
    return { name: (name ?? '').trim(), type: (type ?? 'string').trim() };
  });
}

function modePanel(mode, spec) {
  const b = state.boot ?? {};
  if (mode === 'single-file') {
    const s = spec.single ?? {};
    return h('section.panel', {},
      h('header', {}, h('h2', { text: 'Single-file capabilities' }), h('span.sp'), chip('no server', 'warn')),
      h('div.panel-body.tight', {},
        h('div.grid2', {},
          field('Persistence', select('persistence', b.persistence, s.persistence, (v) => setSpecSection('single', { persistence: v }))),
          field('Layout priority', select('layout', b.layouts, s.layout, (v) => setSpecSection('single', { layout: v })))),
        field('Allowed CDN libraries', h('div', { style: 'display:grid;gap:4px' },
          ...Object.entries(b.cdnLibs ?? {}).filter(([k]) => k !== 'chart-lite').map(([k, lib]) => h('label.check', {},
            h('input', { type: 'checkbox', checked: (s.allowCdn ?? []).includes(k), onchange: (e) => setSpecSection('single', { allowCdn: toggle(s.allowCdn ?? [], k, e.target.checked) }) }),
            h('span', {}, lib.label, h('div.hint', { text: `${lib.sizeKb} KB · global: ${lib.global} · ${lib.use}` })))))),
        h('div.hint', { text: 'Every library you allow is a version the model must not get wrong, and a network dependency a file:// app will eventually run without. Empty is the strong default.' }),
        h('div.divider'),
        h('label.check', {}, h('input', { type: 'checkbox', checked: s.offlineFirst !== false, onchange: (e) => setSpecSection('single', { offlineFirst: e.target.checked }) }), h('span', { text: 'Must be fully usable with no network' })),
        h('label.check', {}, h('input', { type: 'checkbox', checked: !!s.keyboardShortcuts, onchange: (e) => setSpecSection('single', { keyboardShortcuts: e.target.checked }) }), h('span', { text: 'Keyboard shortcuts + a "?" help sheet' })),
        h('label.check', {}, h('input', { type: 'checkbox', checked: !!s.shareData, onchange: (e) => setSpecSection('single', { shareData: e.target.checked }) }), h('span', { text: 'Export / re-import the whole state as one JSON file' }))));
  }

  const st = spec.stack ?? {};
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Stack & scope' }), h('span.sp'), chip(st.deploy ?? 'local')),
    h('div.panel-body.tight', {},
      field('Stack (pinned)', h('select', { onchange: (e) => setSpecSection('stack', { stackId: e.target.value }) },
        ...Object.entries(b.stacks ?? {}).map(([k, v]) => h('option', { value: k, selected: st.stackId === k, text: v.label }))),
        b.stacks?.[st.stackId]?.notes ?? ''),
      h('div.grid2', {},
        field('Auth', select('auth', b.authChoices, st.auth, (v) => setSpecSection('stack', { auth: v }))),
        field('Realtime', select('realtime', b.realtimeChoices, st.realtime, (v) => setSpecSection('stack', { realtime: v }))),
        field('Deploy target', select('deploy', b.deployChoices, st.deploy, (v) => setSpecSection('stack', { deploy: v }))),
        field('Tests', select('tests', b.testChoices, st.tests, (v) => setSpecSection('stack', { tests: v })))),
      field(`Seed rows per table — ${st.seedVolume ?? 40}`, h('input', { type: 'range', min: 0, max: 500, step: 5, value: st.seedVolume ?? 40, oninput: (e) => setSpecSection('stack', { seedVolume: Number(e.target.value) }, 'spec:text') })),
      h('label.check', {}, h('input', { type: 'checkbox', checked: !!st.multiUser, onchange: (e) => setSpecSection('stack', { multiUser: e.target.checked }) }), h('span', { text: 'More than one user shares this data' }))));
}

function optionsPanel() {
  const o = state.options;
  const m = models.byId(state.modelId);
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Prompt strategy' }), h('span.sp'), chip(o.strategy === 'auto' ? 'auto' : o.strategy, 'melt')),
    h('div.panel-body.tight', {},
      field('Splitting', segmented('strategy', ['auto', 'oneshot', 'guided-oneshot', 'staged'], o.strategy, (v) => setOption('strategy', v), (v) => state.boot?.strategies?.[v]?.split(' ')[0] ?? v),
        state.boot?.strategies?.[o.strategy] ?? ''),
      h('label.check', {}, h('input', { type: 'checkbox', checked: o.planFirst, onchange: (e) => setOption('planFirst', e.target.checked) }),
        h('span', { text: 'Plan first (JSON contract before code)' })),
      h('label.check', {}, h('input', { type: 'checkbox', checked: o.includeAudit, onchange: (e) => setOption('includeAudit', e.target.checked) }),
        h('span', { text: 'Include audit & patch stage' }), ),
      field('Contract length', segmented('compact', ['auto', 'always', 'never'], o.compactRules, (v) => setOption('compactRules', v), (v) => ({ auto: 'fit-driven', always: 'core rules', never: 'full' })[v])),
      m?.freeTier?.rpd
        ? h('div.hint', { text: `Auto mode compares the artifact size with this model's ${fmt.tokens(m.outputCeiling)} output ceiling; the audit stage and plan stage each cost 1 of ${m.freeTier.rpd} daily requests.` })
        : h('div.hint', { text: 'Auto mode compares the artifact size with the model output ceiling and the published request budget.' })));
}

function projectPanel() {
  const p = state.projects ?? [];
  return h('section.panel', {},
    h('header', {}, h('h2', { text: 'Projects' }), h('span.sp'),
      h('button.btn.xs.tiny', { onclick: saveProject, text: state.busy.save ? 'saving…' : state.projectId ? 'update' : 'save' })),
    h('div.panel-body.tight', {},
      ...(p.length
        ? [h('ul.list-plain', {}, ...p.map((row) => h('li', {},
            h('div.row', {},
              h('span', { style: 'flex:1;min-width:0;font-weight:600;font-size:12.5px', text: row.name }),
              chip(row.mode === 'full-stack' ? 'stack' : 'file'),
              h('button.mini', { text: '×', title: 'Delete', onclick: () => deleteProject(row.id) })),
            h('div.sub', {}, `${row.pack_count} packs · ${fmt.ago(row.updated_at)}`,
              ' ', h('button.btn.xs.ghost', { onclick: () => openProject(row.id), text: 'open' }))
          )))]
        : [h('div.hint', { text: 'Saved briefs live in SQLite on the server; the current one is also mirrored to localStorage so a reload never loses it.' })])));
}

/* ------------------------------ controls ------------------------------ */

function input(key, value, placeholder) {
  return h('input', { type: 'text', value: value ?? '', placeholder, oninput: (e) => setSpec({ [key]: e.target.value }, 'spec:text') });
}

function select(key, options, value, onPick) {
  return h('select', { onchange: (e) => onPick(e.target.value) },
    ...Object.entries(options ?? {}).map(([k, v]) => h('option', { value: k, selected: k === value, text: typeof v === 'string' ? v : v?.label ?? k })));
}

function segmented(key, values, value, onPick, labelFn) {
  return h('div.seg', { role: 'group', 'aria-label': key },
    ...values.map((v) => h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onPick(v), text: labelFn ? labelFn(v) : fmt.title(v) })));
}

const lines = (text) => String(text).split('\n').map((s) => s.trim()).filter(Boolean);
const toggle = (arr, v, on) => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));
