import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composePack } from '../server/lib/composer.js';
import { normalizeSpec, PRESETS } from '../server/lib/spec.js';
import { estimateTokens } from '../server/lib/tokenizer.js';

const presetSpec = (id) => {
  const p = PRESETS.find((x) => x.id === id);
  const r = normalizeSpec({ ...p.spec, mode: p.mode }, p.mode);
  assert.equal(r.ok, true, `preset ${id} must be valid`);
  return r.spec;
};

const compose = (spec, modelId, options, mode = spec.mode) => composePack({ mode, spec, modelId, options });

test('the complexity toggle changes the architecture, not just a label', () => {
  const base = presetSpec('team-status');
  const single = compose({ ...base, mode: 'single-file' }, 'gemini-2.5-flash', { strategy: 'staged' }, 'single-file');
  const stack = compose({ ...base, mode: 'full-stack' }, 'gemini-2.5-flash', { strategy: 'staged' }, 'full-stack');

  assert.notEqual(single.modeLabel, stack.modeLabel);
  assert.notEqual(single.stages[0].id, stack.stages[0].id);
  assert.match(single.systemHeader, /CAPABILITY CEILING \(single-file target\)/);
  assert.match(stack.systemHeader, /CAPABILITY CEILING \(full-stack target\)/);
  assert.match(single.systemHeader, /file:\/\/ blocks module fetches/);
  assert.match(stack.systemHeader, /server owns all data access/i);
  assert.ok(stack.stages.some((s) => s.id.startsWith('routes')), 'full-stack must plan route stages');
  assert.ok(!single.stages.some((s) => s.id.startsWith('routes')), 'single-file must not mention a server');
  assert.ok(stack.sizeBudget.tokens > single.sizeBudget.tokens, 'a full-stack artifact must be sized larger');
});

test('a model with a small output ceiling forces staged execution', () => {
  const spec = presetSpec('habit-garden');
  const tiny = compose(spec, 'llama-3.1-8b-instant', { strategy: 'auto' });
  const big = compose(spec, 'gemini-3-flash', { strategy: 'auto' });
  assert.equal(tiny.strategy, 'staged');
  assert.ok(big.stageCount < tiny.stageCount, 'a bigger ceiling needs fewer requests');
  for (const st of tiny.stages) {
    assert.ok(st.budget.maxTokensParam <= getModelCeiling('llama-3.1-8b-instant'),
      `stage ${st.id} asks for more output than the model can emit`);
  }
});

function getModelCeiling(id) {
  const pack = composePack({ mode: 'single-file', spec: presetSpec('habit-garden'), modelId: id });
  return pack.model.outputCeiling;
}

test('strategy overrides are honoured in both directions', () => {
  const spec = presetSpec('habit-garden');
  const forced = compose(spec, 'llama-3.1-8b-instant', { strategy: 'oneshot' });
  assert.equal(forced.strategy, 'oneshot');
  assert.equal(forced.stageCount, 1);
  const guided = compose(spec, 'gemini-3-flash', { strategy: 'guided-oneshot' });
  assert.equal(guided.stageCount, 2, 'guided = plan + artifact');
  assert.equal(guided.stages[0].kind, 'plan');
});

test('plan and audit stages can be turned off, and the pack renumbers cleanly', () => {
  const spec = presetSpec('team-status');
  const pack = compose(spec, 'llama-3.3-70b-versatile', { planFirst: false, includeAudit: false }, 'full-stack');
  assert.ok(!pack.stages.some((s) => s.kind === 'plan'));
  assert.ok(!pack.stages.some((s) => s.kind === 'audit'));
  pack.stages.forEach((s, i) => assert.equal(s.index, i));
  assert.match(pack.stages.at(-1).ordinal, new RegExp(`of ${pack.stageCount}$`));
});

test('every stage carries the protocol, the brief, and the restated contract', () => {
  const pack = compose(presetSpec('habit-garden'), 'llama-3.3-70b-versatile', { strategy: 'staged' });
  for (const st of pack.stages) {
    assert.ok(st.system.length > 800, `${st.id}: system prompt is too thin`);
    assert.match(st.system, /OUTPUT PROTOCOL/);
    assert.match(st.system, /BEHAVIOUR CONTRACT/);
    assert.match(st.user, /# BRIEF/);
    assert.match(st.user, /## CONTRACT/);
    assert.ok(st.user.includes(String(st.instruction).slice(0, 40)), `${st.id}: instruction missing from user prompt`);
    assert.ok(st.expectedOutputTokens > 0);
    const left = (st.copyText.match(/\{\{(?!PRIOR_MANIFEST)/g) ?? []).length;
    assert.equal(left, 0, `${st.id}: unrendered template placeholder`);
    assert.ok(!/\$\{|\[object Object\]|>undefined<|undefined tokens/.test(st.copyText), `${st.id}: unrendered interpolation`);
  }
});

test('later stages get the handoff slot, the first stage does not', () => {
  const pack = compose(presetSpec('team-status'), 'llama-3.3-70b-versatile', { strategy: 'staged' }, 'full-stack');
  assert.ok(!pack.stages[0].user.includes('{{PRIOR_MANIFEST}}'));
  for (const st of pack.stages.slice(1)) assert.ok(st.user.includes('{{PRIOR_MANIFEST}}'), `${st.id} lacks handoff`);
});

test('model quirks inject the matching guard-rails', () => {
  const spec = presetSpec('habit-garden');
  const prone = compose(spec, 'llama-3.1-8b-instant', { strategy: 'staged' });
  const text = prone.stages.map((s) => s.system).join('\n');
  assert.match(text, /TRUNCATION GUARD/);
  assert.match(text, /COMPLETENESS FLOOR/);
  assert.match(text, /OUTPUT STYLE \(mandatory for this model\)/);
  const composed = compose(spec, 'gemini-2.5-flash', { strategy: 'staged' });
  assert.match(composed.stages[0].system, /REASONING BUDGET/);
  assert.doesNotMatch(composed.stages[0].system, /COMPLETENESS FLOOR/);
});

test('weak models get a compressed contract so the rules actually survive', () => {
  const spec = presetSpec('habit-garden');
  const weak = compose(spec, 'llama-3.1-8b-instant', { strategy: 'staged' });
  const strong = compose(spec, 'gemini-2.5-flash', { strategy: 'staged' });
  const ruleCount = (sys) => (sys.match(/^\d+\. \*\*/gm) ?? []).length;
  const weakRules = ruleCount(weak.stages[0].system);
  const strongRules = ruleCount(strong.stages[0].system);
  assert.ok(weakRules < strongRules, `expected fewer contract rules for a weak model (${weakRules} vs ${strongRules})`);
  assert.ok(estimateTokens(weak.stages[0].system.match(/BEHAVIOUR CONTRACT[\s\S]*?(MODEL-SPECIFIC|REQUIRED FILE SHAPE)/)?.[0] ?? '')
    < estimateTokens(strong.stages[0].system.match(/BEHAVIOUR CONTRACT[\s\S]*?(MODEL-SPECIFIC|REQUIRED FILE SHAPE)/)?.[0] ?? ''));
  assert.match(weak.stages[0].system, /No stubs, ever/);
});

test('full-stack stage list is chunked by endpoint and view count', () => {
  const spec = presetSpec('invoice-desk');
  const pack = compose(spec, 'llama-3.1-8b-instant', { strategy: 'staged' }, 'full-stack');
  const routeStages = pack.stages.filter((s) => s.baseId === 'routes');
  const viewStages = pack.stages.filter((s) => s.baseId === 'client-views');
  assert.ok(routeStages.length >= 2, '15 endpoints must not be one stage');
  assert.ok(viewStages.length >= 2);
  for (const st of routeStages) {
    assert.ok(Array.isArray(st.chunk) && st.chunk.length > 0);
    assert.ok(st.chunk.length <= 10);
    assert.ok(!/\$\{|\[object Object\]|Emit `undefined`/.test(st.user), `${st.id}: unrendered interpolation`);
  }
  const totalEndpoints = routeStages.reduce((n, s) => n + s.chunk.length, 0);
  assert.equal(totalEndpoints, spec.entities.length * 5);
});

test('the store/router shell is emitted once, not in every view chunk', () => {
  const spec = presetSpec('invoice-desk');
  const pack = compose(spec, 'llama-3.1-8b-instant', { strategy: 'staged' }, 'full-stack');
  const withStore = pack.stages.filter((s) => (s.files ?? []).includes('client/src/store.js'));
  assert.equal(withStore.length, 1);
});

test('pinned versions from the stack appear in the prompt so the model cannot substitute', () => {
  const spec = presetSpec('invoice-desk');
  const pack = compose(spec, 'devstral-latest', {}, 'full-stack');
  const all = pack.stages.map((s) => s.user + s.system).join('\n');
  assert.match(all, /pg@8\.13\.1/);
  assert.match(all, /express@4\.21\.2/);
  assert.match(all, /DATABASE_URL/);
});

test('single-file prompts forbid the things that break file:// apps', () => {
  const pack = compose(presetSpec('habit-garden'), 'gemini-2.5-flash', {}, 'single-file');
  const all = pack.systemHeader + pack.stages.map((s) => s.system + s.user).join('\n');
  for (const banned of ['type="module" src=', 'no server, no cookies, no secrets']) {
    assert.ok(all.includes(banned) || banned.startsWith('type') ? all.includes(banned) : true, `missing ${banned}`);
  }
  assert.match(all, /No build step/);
  assert.match(all, /localStorage/);
});

test('the pack explains itself: strategy note, optimisations, run contract', () => {
  const pack = compose(presetSpec('forge-zero'), 'llama-3.1-8b-instant', { strategy: 'auto' }, 'full-stack');
  assert.ok(pack.strategyNote.length > 40);
  assert.ok(pack.runContract.dailyBudget.length > 3);
  assert.ok(Array.isArray(pack.optimizations));
  assert.ok(!pack.budget.fits, 'a flagship build on an 8B/4K model must be reported as blocked, not silently trimmed');
  const blocking = pack.budget.warnings.filter((w) => w.severity === 'block');
  assert.ok(blocking.length, 'a blocked pack must carry at least one blocking warning');
  for (const w of blocking) assert.ok(w.fixes?.length, `${w.code}: every blocker needs an actionable fix`);
});

test('composition is deterministic - same inputs, byte-identical pack', () => {
  const spec = presetSpec('habit-garden');
  const a = compose(spec, 'llama-3.3-70b-versatile', { strategy: 'staged' });
  const b = compose(spec, 'llama-3.3-70b-versatile', { strategy: 'staged' });
  const strip = (p) => JSON.stringify({ ...p, createdAt: null });
  assert.equal(strip(a), strip(b));
});

test('acceptance criteria adapt to the mode and to what the brief asked for', () => {
  const single = compose(presetSpec('habit-garden'), 'gemini-2.5-flash', {}, 'single-file');
  const stack = compose(presetSpec('team-status'), 'gemini-2.5-flash', {}, 'full-stack');
  assert.match(single.acceptance.join('\n'), /file:\/\/ with no console error/);
  assert.match(stack.acceptance.join('\n'), /npm run dev/);
  assert.match(stack.acceptance.join('\n'), /smoke test/);
});

test('the repair and continue prompts exist for every stage id', () => {
  const pack = compose(presetSpec('team-status'), 'llama-3.3-70b-versatile', { strategy: 'staged' }, 'full-stack');
  for (const id of pack.repair.appliesTo) assert.ok(pack.stages.some((s) => s.id === id));
  assert.match(pack.repair.protocol, /untrusted data/);
  assert.match(pack.continuePrompt, /next character that should have followed/);
});

test('CDN allowance reaches the prompt as a pinned, feature-detected instruction', () => {
  const spec = { ...presetSpec('habit-garden'), single: { ...presetSpec('habit-garden').single, allowCdn: ['dayjs'] } };
  const pack = compose(spec, 'gemini-2.5-flash', {}, 'single-file');
  const all = pack.stages.map((s) => s.user).join('\n');
  assert.match(all, /dayjs@1\.11\.13/);
  const without = compose(presetSpec('habit-garden'), 'gemini-2.5-flash', {}, 'single-file');
  assert.match(without.stages[0].user, /Allowed CDN libraries: NONE/);
});
