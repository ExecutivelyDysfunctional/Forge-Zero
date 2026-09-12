/**
 * The pack: stage cards, streaming run console, mechanical verification and the
 * sandboxed preview.
 *
 * Everything a user needs to *act* on a prompt lives here, including the parts a
 * generic prompt UI forgets: which stage you are allowed to re-run, whether a
 * reply truncated, and what the single-file artifact does when it actually opens.
 */
import { api, stream } from './api.js';
import { h, fmt, chip, copyText, download, toast, renderMarkdownish } from './ui.js';
import { state, stageUi, composeNow, models } from './state.js';

export function renderPack(host) {
  host.textContent = '';
  if (state.busy.compose) {
    host.append(h('div.panel', {}, h('div.panel-body', {}, h('div.status', {}, h('span.spin'), ' composing pack…'))));
    return;
  }
  if (!state.pack) {
    host.append(h('div.empty-state', {},
      h('h3', { text: state.error ? 'The brief needs one more thing' : 'Write a brief to compose a pack' }),
      h('p', { text: state.error ?? 'The pack is generated locally from the brief and the model limits — no API key, no network.' }),
      state.error ? h('div.warning.block', { style: 'text-align:left' }, h('div.t', { text: 'Brief rejected' }), h('div.d', { text: state.error })) : null));
    return;
  }
  const pack = state.pack;
  const m = pack.model;
  const key = models.keyState(m.id);

  host.append(
    h('div.pack-head', {},
      h('div.pack-title', {},
        h('h1', { text: pack.spec.name }),
        chip(pack.modeLabel, 'melt'),
        chip(m.label, 'plain'),
        chip(pack.strategy, pack.strategy === 'oneshot' ? 'good' : 'plain'),
        chip(`${pack.stageCount} request${pack.stageCount === 1 ? '' : 's'}`),
        chip(`~${fmt.tokens(pack.sizeBudget.tokens)} out`, 'plain'),
        pack.budget.fits ? chip('fits', 'good') : chip('blocked', 'bad')),
      h('div.strategy-note', { html: '' }, h('span', { text: pack.strategyNote })),
      h('div.actions', {},
        h('button.btn.sm', { onclick: composeNow, text: '↻ recompose' }),
        h('button.btn.sm', { onclick: () => copyPack(pack), text: '⧉ copy pack' }),
        h('button.btn.sm', { onclick: () => exportPack('md'), text: '↓ .md' }),
        h('button.btn.sm', { onclick: () => exportPack('json'), text: '↓ .json' }),
        h('button.btn.sm', { onclick: () => exportPack('curl'), text: '↓ run-pack.sh' }),
        h('button.btn.sm', { onclick: () => exportPack('bundle'), text: '↓ bundle' }),
        h('span.sp'),
        key?.configured
          ? chip(`key ••••${(key.fingerprint ?? '').slice(0, 4)}`, 'good')
          : chip(m.provider === 'ollama' ? 'local endpoint' : 'no key — copy/export still work', 'warn'))),

    ...pack.stages.map((stage, i) => stageCard(stage, i, pack, m)),

    h('div.panel', {},
      h('header', {}, h('h2', { text: 'Assembly order' })),
      h('div.panel-body.tight', {},
        h('ol', { style: 'margin:0;padding-left:18px;font-size:12.5px;color:var(--ink-dim)' },
          ...pack.assembly.stitch.map((s) => h('li', { style: 'margin-bottom:4px', text: s }))),
        h('div.divider'),
        h('div.meta-grid', {},
          meta('verify', pack.assembly.verifyCommand),
          meta('requests', pack.runContract.requests),
          meta('daily budget', pack.runContract.dailyBudget),
          meta('spacing', `${pack.budget.minSpacingSec}s min`)),
        h('div.hint', { text: pack.assembly.resumeHint }))));
}

const meta = (k, v) => h('div.meta', {}, h('div.k', { text: k }), h('div.v', { text: String(v) }));

function stageCard(stage, i, pack, m) {
  const ui = stageUi(stage.id);
  const open = ui.open;
  const kindClass = stage.kind === 'plan' ? '.plan' : stage.kind === 'audit' ? '.audit' : '';
  const card = h('article.stage' + (open ? '.active' : ''), { dataset: { stage: stage.id } },
    h('div.stage-head', { onclick: () => { ui.open = !ui.open; renderPack(document.getElementById('center')); } },
      h('div.stage-idx' + kindClass, { text: open ? String(i + 1) : `${i + 1}` }),
      h('div.stage-title', {},
        h('div.t', { text: stage.title }),
        h('div.d', { text: stage.deliverable })),
      h('div.stage-metrics', {},
        chip(`${fmt.tokens(stage.tokens.input)} in`, 'plain'),
        chip(`≤${fmt.tokens(stage.budget.maxTokensParam)} out`, stage.budget.ceilingPct > 82 ? 'warn' : 'plain'),
        chip(`ctx ${stage.budget.contextPct}%`, stage.budget.contextPct > 78 ? 'warn' : 'plain'),
        stage.budget.seconds ? chip(`~${stage.budget.seconds}s`, 'plain') : null,
        ui.status ? chip(ui.status, ui.status.includes('fail') ? 'bad' : 'good') : null,
        h('span', { style: 'font-size:11px;color:var(--ink-mute)', text: open ? 'collapse ▲' : 'expand ▼' }))),
    open ? body() : null
  );
  return card;

  function body() {
    const pre = h('pre.prompt');
    paintPrompt(pre, ui.tab || 'user');
    return h('div.stage-body', {},
      h('div.stage-purpose', { text: stage.purpose }),
      h('div.tabs', { role: 'tablist' },
        ...['user', 'system', 'both'].map((t) => h('button', {
          role: 'tab', 'aria-selected': String((ui.tab || 'user') === t), onclick: (e) => { ui.tab = t; e.currentTarget.parentElement.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', 'false')); e.currentTarget.setAttribute('aria-selected', 'true'); paintPrompt(pre, t); },
          text: t === 'both' ? 'full prompt' : t + ' prompt',
        })),
        h('span.sp', { style: 'flex:1' }),
        h('button.btn.xs.tiny', { onclick: () => copyText(copyFor(t)), text: 'copy' })),
      pre,
      h('div.meta-grid', {},
        meta('temperature', stage.params.temperature),
        meta('max_tokens', stage.budget.maxTokensParam),
        meta('expected out', fmt.tokens(stage.budget.expectedOutputTokens)),
        meta('lines ≤', stage.maxLines)),
      h('div', {}, h('div.lbl', { text: 'Postflight checks' }),
        h('ul.postflight', {}, ...stage.postflight.map((p) => h('li', { text: p })))),
      h('div.divider'),
      h('div.row', {},
        runButton(),
        h('button.btn.sm.ghost', {
          onclick: () => copyText(stage.copyText), text: 'copy stage',
        }),
        m.freeTier?.rpd ? chip(`1 of ${m.freeTier.rpd} today`, 'plain') : null),
      h('details', { style: 'margin-top:6px' },
        h('summary', { style: 'cursor:pointer;font-size:12px;color:var(--ink-mute)', text: 'Paste a reply to verify it (no API key needed)' }),
        verifyBlock()),
      ui.out || ui.streaming ? consoleBlock() : null,
      pack.mode === 'single-file' && ui.preview ? h('div', { style: 'margin-top:10px' },
        h('div.preview-chrome', {}, h('span', { text: 'SANDBOXED PREVIEW · index.html from stored artifacts' }),
          h('span.sp', { style: 'flex:1' }),
          h('button.btn.xs.ghost', { onclick: () => assemble(true), text: 'reload' })),
        h('iframe.preview-frame', { src: ui.preview, sandbox: 'allow-scripts', title: 'Assembled single-file preview', referrerpolicy: 'no-referrer' })) : null);
  }

  function paintPrompt(target, tab) {
    const text = copyFor(tab);
    renderMarkdownish(target, text);
    ui._lastPaint = tab;
  }

  function copyFor(tab) {
    const t = tab ?? ui.tab ?? 'user';
    if (t === 'user') return stage.user;
    if (t === 'system') return stage.system;
    return stage.copyText;
  }

  function runButton() {
    if (ui.streaming) return h('button.btn.sm.primary', { disabled: true }, h('span.spin'), ' streaming…');
    return h('button.btn.sm.primary', {
      onclick: () => runStage(i),
      text: i === 0 ? '▶ run stage' : `▶ run & use prior manifest`,
    });
  }

  function verifyBlock() {
    const ta = h('textarea.mono', { rows: 6, placeholder: 'Paste the model reply here to check the protocol: file headers, brace balance, stub language, secrets, truncation.', oninput: (e) => { ui._paste = e.target.value; } });
    return h('div', { style: 'display:grid;gap:6px;margin-top:6px' },
      ta,
      h('div.row', {},
        h('button.btn.xs', { onclick: async () => { await runVerify(ta.value, stage); }, text: 'verify reply' })),
      ui.verify ? h('div', { style: 'display:grid;gap:5px' },
        h('div.row', {}, chip(ui.verify.ok ? 'accepted' : 'rejected', ui.verify.ok ? 'good' : 'bad'),
          ui.verify.needsContinuation ? chip('needs continuation', 'warn') : null,
          ui.verify.files?.length ? chip(`${ui.verify.files.length} file(s)`, 'plain') : null),
        ...(ui.verify.issues ?? []).map((iss) => h('div.warning' + (iss.severity === 'block' ? '.block' : iss.severity === 'warn' ? '.warn' : '.info'), {},
          h('div.t', { text: iss.title }), h('div.d', { text: iss.message }))),
        ui.verify.ok ? h('button.btn.xs', { onclick: () => assemble(), text: 'reassemble & preview' }) : null) : null);
  }

  function consoleBlock() {
    const out = h('pre.out', { text: ui.out });
    ui._outEl = out;
    return h('div', { style: 'margin-top:8px' },
      h('div.row', {}, h('span.lbl', { text: 'model output' }), ui.meta ? chip(`${fmt.tokens(ui.meta.estTokens)} est in`, 'plain') : null,
        ui.done ? chip(`${ui.done.ms} ms`, 'plain') : null,
        ui.done?.usage?.output ? chip(`${ui.done.usage.output} out`, 'good') : null,
        ui.needsContinuation ? h('button.btn.xs', { onclick: () => runStage(i, 'continue'), text: '↻ continue from cut' }) : null),
      out);
  }
}

async function runVerify(text, stage) {
  if (!state.packId) return toast('Compose a persisted pack first', 'err');
  try {
    const res = await api.verify(state.packId, { stageKey: stage.id, text });
    stageUi(stage.id).verify = res.verify;
    toast(res.verify.ok ? 'Reply accepted' : 'Reply rejected — see the checks', res.verify.ok ? 'ok' : 'err');
    renderPack(document.getElementById('center'));
  } catch (err) {
    toast(`Verify failed: ${err.message}`, 'err');
  }
}

export async function runStage(index, mode = 'stage', extra = {}) {
  const pack = state.pack;
  const stage = pack.stages[index];
  const ui = stageUi(stage.id);
  ui.streaming = true;
  ui.out = '';
  ui.status = 'running';
  ui.verify = null;
  ui.needsContinuation = false;
  renderPack(document.getElementById('center'));
  const started = performance.now();
  try {
    await stream('/api/generate', {
      packId: state.packId, stageIndex: index, mode, context: extra.context ?? '', ...extra,
    }, {
      onMeta: (d) => { ui.meta = d; },
      onDelta: (t) => {
        ui.out += t;
        if (ui._outEl) { ui._outEl.textContent = ui.out; ui._outEl.scrollTop = ui._outEl.scrollHeight; }
      },
      onDone: (d) => {
        ui.done = d;
        ui.streaming = false;
        ui.status = d.ok ? 'accepted' : 'verify-failed';
        ui.verify = { ok: d.ok, needsContinuation: d.needsContinuation, issues: d.issues, files: d.files };
        ui.needsContinuation = d.needsContinuation;
        toast(`Stage ${index + 1} ${d.ok ? 'accepted' : 'needs attention'} in ${fmt.ms(d.ms)}${d.attempts > 1 ? ` (${d.attempts} attempts)` : ''}`, d.ok ? 'ok' : 'err');
      },
      onError: (d) => {
        ui.streaming = false;
        ui.status = 'error';
        ui.error = d;
        toast(d.error + (d.recovery ? ' — ' + d.recovery.split('.')[0] + '.' : ''), 'err');
      },
    });
  } catch (err) {
    ui.streaming = false;
    ui.status = 'error';
    ui.error = { error: err.message };
    toast(err.message, 'err');
  }
  ui.open = true;
  ui.elapsedMs = Math.round(performance.now() - started);
  if (ui.status === 'accepted' && pack.mode === 'single-file') await assemble();
  renderPack(document.getElementById('center'));
}

export async function assemble(silent = false) {
  if (!state.packId) return;
  try {
    const res = await api.assemble(state.packId);
    const ui = state.pack ? stageUi(state.pack.stages.at(-1).id) : null;
    if (res.previewUrl) {
      for (const s of state.pack?.stages ?? []) stageUi(s.id).preview = null;
      const last = state.pack?.stages.at(-1);
      if (last) stageUi(last.id).preview = res.previewUrl + '?r=' + Date.now();
      if (!silent) toast(`Assembled ${res.files.length} file(s) · complete: ${res.complete ? 'yes' : 'not yet'}`, res.complete ? 'ok' : '');
    } else if (!silent) {
      toast(res.files?.length ? `${res.files.length} files assembled; preview only renders a single-file pack` : 'Nothing stored to assemble yet — run at least one stage', '');
    }
    state.assembly = res;
  } catch (err) {
    if (!silent) toast(`Assemble failed: ${err.message}`, 'err');
  }
}

async function exportPack(format) {
  if (!state.packId) return toast('No persisted pack to export', 'err');
  if (format === 'curl' || format === 'md') {
    const res = await fetch(`/api/packs/${state.packId}/export?format=${format}`);
    const text = await res.text();
    download(format === 'md' ? 'prompt-pack.md' : 'run-pack.sh', text, format === 'md' ? 'text/markdown' : 'text/x-shellscript');
    toast('Downloaded', 'ok');
    return;
  }
  const data = await api.exportPack(state.packId, format);
  if (format === 'bundle') {
    for (const [name, contents] of Object.entries(data.files)) download(name.replace(/[\\/]/g, '-'), contents, 'text/plain');
    toast(`${Object.keys(data.files).length} files downloaded`, 'ok');
    return;
  }
  download('prompt-pack.json', JSON.stringify(data, null, 2), 'application/json');
  toast('Downloaded prompt-pack.json', 'ok');
}

async function copyPack(pack) {
  const text = [
    `# FORGE-ZERO PROMPT PACK — ${pack.spec.name}`,
    `# target: ${pack.modeLabel} · model: ${pack.model.label} (${pack.model.id}) · strategy: ${pack.strategy}`,
    '',
    ...pack.stages.map((s, i) => [
      `\n${'='.repeat(78)}`,
      `STAGE ${i + 1}/${pack.stages.length} — ${s.title}`,
      `${'='.repeat(78)}\n`,
      s.copyText,
    ].join('\n')),
  ].join('\n');
  if (await copyText(text)) toast(`Copied ${pack.stages.length}-stage pack (${fmt.bytes(text.length)})`, 'ok');
  else toast('Clipboard blocked by the browser; use Export instead', 'err');
}
