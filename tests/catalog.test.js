import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, listModels, getModel, DEFAULT_MODEL_ID, recommendModels, fallbackChain, QUIRKS, catalogMeta } from '../server/lib/catalog.js';
import { QUIRK_RULES } from '../server/lib/blueprint.js';

test('every provider exposes the fields the composer and client rely on', () => {
  assert.ok(PROVIDERS.length >= 6, 'expected a broad free-tier catalogue');
  for (const p of PROVIDERS) {
    for (const key of ['id', 'label', 'family', 'baseUrl', 'keyUrl', 'authHeader']) {
      assert.ok(p[key], `${p.id} missing ${key}`);
    }
    assert.ok(Array.isArray(p.models) && p.models.length, `${p.id} has no models`);
  }
});

test('every model profile is complete and internally consistent', () => {
  const seen = new Set();
  for (const m of listModels()) {
    const where = `${m.provider}/${m.id}`;
    assert.ok(!seen.has(m.id), `duplicate model id ${m.id}`);
    seen.add(m.id);
    assert.ok(m.contextWindow > m.outputCeiling, `${where}: ceiling must be smaller than context`);
    assert.ok(m.outputCeiling >= 1024, `${where}: output ceiling too small to be useful`);
    assert.ok(m.quality > 0 && m.quality <= 10, `${where}: quality out of range`);
    assert.ok(m.freeTier && typeof m.freeTier === 'object', `${where}: no freeTier block`);
    assert.equal(m.freeTier.cardRequired, false, `${where}: not a no-card free tier`);
    assert.ok(m.sampling?.temperature != null, `${where}: missing sampling preset`);
    assert.ok(Array.isArray(m.bestFor) && m.bestFor.length, `${where}: bestFor empty`);
    assert.ok(m.verifiedAt, `${where}: limits need a verification date`);
    for (const q of m.quirks) {
      assert.ok(QUIRKS[q], `${where}: unknown quirk ${q}`);
      assert.ok(q in QUIRK_RULES, `${where}: quirk ${q} has no prompt rule`);
    }
  }
});

test('unknown model ids inherit conservative limits instead of optimistic ones', () => {
  const known = getModel('llama-3.1-8b-instant');
  const guess = getModel('brand-new-model-2027', { provider: 'groq' });
  assert.equal(guess.unverified, true);
  assert.ok(guess.outputCeiling <= known.outputCeiling || guess.outputCeiling <= 8192);
  assert.ok(guess.quirks.includes('truncation'), 'unknown models must assume truncation');
});

test('the default model is real and strong enough to be a good first answer', () => {
  const m = getModel(DEFAULT_MODEL_ID);
  assert.ok(m.outputCeiling >= 8192);
  assert.ok(m.quality >= 7);
});

test('recommendation prefers models that can actually finish the job', () => {
  const small = recommendModels({ mode: 'single-file', targetOutputTokens: 1500, requestsNeeded: 1, inputTokensPerRequest: 1500 });
  const huge = recommendModels({ mode: 'full-stack', targetOutputTokens: 34_000, requestsNeeded: 9, inputTokensPerRequest: 4000 });
  assert.ok(small.length > 5 && huge.length > 5);
  // A 4K-ceiling model cannot hold a 34K-token plan in nine requests without
  // many extra splits, so it must not win against a 32K-ceiling model.
  const tinyRank = small.findIndex((r) => r.modelId === 'llama-3.1-8b-instant');
  const hugeRank = huge.findIndex((r) => r.modelId === 'llama-3.1-8b-instant');
  assert.ok(tinyRank >= 0, 'the 8B model must still be scored for a small job');
  assert.ok(hugeRank === -1 || hugeRank > 6, `tiny model ranked ${hugeRank} for a 34K-token plan`);
  assert.ok(tinyRank < hugeRank || hugeRank === -1, 'the same model must rank worse as the plan grows');
  const top = huge[0];
  assert.ok(top.outputCeiling >= 8192, 'best pick must have a usable ceiling');
});

test('fallback chains never suggest the same provider twice', () => {
  const chain = fallbackChain('llama-3.3-70b-versatile', { mode: 'full-stack', targetOutputTokens: 20_000, requestsNeeded: 6, inputTokensPerRequest: 3000 }, 3);
  assert.ok(chain.length >= 1);
  assert.ok(!chain.some((id) => id.startsWith('llama-3.3-70b-versatile')));
  for (const id of chain) assert.notEqual(getModel(id).provider, 'groq', 'fallback must move providers');
});

test('catalogue meta is safe to expose to the client', () => {
  const meta = catalogMeta();
  assert.equal(meta.modelCount, listModels().length);
  assert.ok(meta.providers.every((p) => !p.baseUrl.includes('key')));
});
