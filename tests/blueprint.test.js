import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, CONSTITUTION, STACKS, QUIRK_RULES, OUTPUT_PROTOCOL, CONTRACT_REMINDER, REPAIR_PROTOCOL, CONTINUE_PROTOCOL, rulesFor } from '../server/lib/blueprint.js';
import { listModels, PROVIDERS } from '../server/lib/catalog.js';

test('the constitution is weighted so weak models get a shorter contract', () => {
  const core = rulesFor('both', { extended: false });
  const all = rulesFor('both', { extended: true });
  assert.ok(core.length >= 10 && all.length > core.length);
  for (const r of CONSTITUTION) {
    assert.ok(r.id && r.title && r.text && r.weight && r.applies, `rule ${r.id ?? '?'} is incomplete`);
    assert.ok(['core', 'extended'].includes(r.weight));
    assert.ok(['both', 'single', 'stack'].includes(r.applies));
    assert.ok(r.text.length > 40, `${r.id}: rule text is too vague to enforce`);
  }
  const stackOnly = rulesFor('stack', { extended: true });
  assert.ok(stackOnly.some((r) => r.id === 'api-envelope'));
  assert.ok(!rulesFor('single', { extended: true }).some((r) => r.id === 'api-envelope'));
});

test('output protocol covers every marker the verifier parses', () => {
  const text = OUTPUT_PROTOCOL + CONTRACT_REMINDER;
  for (const marker of ['// FILE:', 'PART:2 OF:3', '<<CONTINUE', '@REPLACE', '@MANIFEST', '@BLOCKED']) {
    assert.ok(text.includes(marker), `protocol never mentions ${marker}`);
  }
});

test('both modes stage a plan, code and a review pass', () => {
  for (const mode of Object.values(MODES)) {
    const kinds = mode.stages.map((s) => s.kind);
    assert.ok(kinds.includes('plan'), `${mode.id}: no plan stage`);
    assert.ok(kinds.includes('code'), `${mode.id}: no code stage`);
    assert.ok(kinds.includes('audit') || kinds.includes('docs'), `${mode.id}: no review stage`);
    for (const st of mode.stages) {
      assert.ok(st.title && st.purpose, `${mode.id}/${st.id}: needs a title and a purpose`);
      assert.ok(typeof st.instruction === 'function', `${st.id}: instruction must be a function of ctx`);
    }
    assert.ok(typeof mode.oneshot === 'function');
    assert.ok(mode.sizeByAmbition.mvp < mode.sizeByAmbition.flagship);
  }
});

test('single-file ceiling names the constraints that actually break file:// apps', () => {
  const c = MODES['single-file'].ceiling;
  for (const s of ['No build step', 'file://', 'localStorage', 'CORS', 'inline SVG']) {
    assert.ok(c.includes(s), `missing: ${s}`);
  }
  assert.match(MODES['single-file'].shape, /CONFIG -> STATE -> STORAGE -> DOMAIN -> RENDER -> EVENTS -> BOOT/);
});

test('every approved stack pins versions and names a database', () => {
  for (const [id, stack] of Object.entries(STACKS)) {
    assert.ok(stack.label && stack.runtime && stack.db && stack.frontend, `${id}: incomplete stack`);
    assert.ok(stack.deps.length >= 1, `${id}: no deps pinned`);
    for (const dep of stack.deps) {
      assert.match(dep, /@|==/, `${id}: ${dep} is not pinned`);
    }
  }
});

test('quirk rules are prose-free of placeholders the composer cannot fill', () => {
  const ctx = { maxLines: 120, parts: 3 };
  for (const [code, rule] of Object.entries(QUIRK_RULES)) {
    if (rule == null) continue;
    const text = typeof rule === 'function' ? rule(ctx) : rule;
    assert.ok(text.length > 60, `${code}: rule too short to matter`);
    assert.ok(!text.includes('{{') && !text.includes('undefined'), `${code}: unrendered placeholder`);
    assert.ok(listModels().some((m) => m.quirks.includes(code)), `${code}: rule exists but no model declares it`);
  }
});

test('repair and continuation protocols treat pasted output as data', () => {
  assert.match(REPAIR_PROTOCOL, /untrusted data/);
  assert.match(REPAIR_PROTOCOL, /@REPLACE/);
  assert.match(CONTINUE_PROTOCOL, /Do not repeat/);
});

test('provider catalogue covers the whole endpoint family set', () => {
  const families = new Set(PROVIDERS.map((p) => p.family));
  assert.ok(families.has('openai') && families.has('gemini') && families.has('mistral'));
  for (const p of PROVIDERS) {
    assert.match(p.baseUrl, /^https?:\/\//, `${p.id}: base url must be absolute`);
    assert.match(p.keyUrl, /^https:\/\//, `${p.id}: free keys need a real signup link`);
  }
});
