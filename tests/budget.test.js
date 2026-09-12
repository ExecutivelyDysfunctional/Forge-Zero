import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseFit, sizeBudgetFor, chunkItems, stageBudget, CEILING_SAFETY } from '../server/lib/budget.js';
import { estimateTokens, estimateOutputTokens, pad } from '../server/lib/tokenizer.js';
import { MODES } from '../server/lib/blueprint.js';
import { normalizeSpec, PRESETS } from '../server/lib/spec.js';

const spec = (id) => {
  const p = PRESETS.find((x) => x.id === id);
  return normalizeSpec({ ...p.spec, mode: p.mode }, p.mode).spec;
};

test('bigger ambition and more features both increase the size estimate', () => {
  const small = sizeBudgetFor(MODES['single-file'], { ...spec('focus-timer'), ambition: 'mvp' });
  const big = sizeBudgetFor(MODES['single-file'], { ...spec('focus-timer'), ambition: 'flagship' });
  assert.ok(big.lines > small.lines * 2);
  const moreFeatures = sizeBudgetFor(MODES['single-file'], { ...spec('focus-timer'), ambition: 'mvp', features: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  assert.ok(moreFeatures.lines > small.lines);
  assert.ok(big.tokens > small.tokens);
});

test('full-stack sizing accounts for auth, tests and fixed overhead', () => {
  const bare = sizeBudgetFor(MODES['full-stack'], { ...spec('team-status'), stack: { ...spec('team-status').stack, auth: 'none', tests: 'none' } });
  const withExtras = sizeBudgetFor(MODES['full-stack'], spec('team-status'));
  assert.ok(withExtras.lines > bare.lines);
});

test('stage sizing never asks a model for more than its ceiling allows', () => {
  const fit = analyseFit({
    model: { id: 't', label: 't', outputCeiling: 4096, contextWindow: 128_000, quality: 8, speedTps: 300, quirks: [], freeTier: { rpm: 30, rpd: 1000, tpm: 6000, tpd: 500_000 } },
    sizeTokens: 40_000, requestCount: 2, inputPerRequest: 2000, repairReserve: 2,
  });
  assert.ok(fit.parts > 2, 'it must add parts rather than overflow');
  assert.ok(fit.perStageTokens <= Math.floor(4096 * CEILING_SAFETY) + 1, 'each part must fit the usable ceiling');
});

test('budget arithmetic reports the blockers a free-tier user actually hits', () => {
  const model = { id: 'or', label: 'or', outputCeiling: 32_768, contextWindow: 131_072, quality: 8.5, speedTps: 100, quirks: [], freeTier: { rpm: 20, rpd: 50, tpm: null, tpd: null } };
  const fit = analyseFit({ model, sizeTokens: 12_000, requestCount: 40, inputPerRequest: 3000 });
  const codes = fit.warnings.map((w) => w.code);
  assert.ok(codes.includes('RPD_OVERRUN'), `expected a daily-request blocker, got ${codes}`);
  assert.equal(fit.fits, false);
  const blocker = fit.warnings.find((w) => w.code === 'RPD_OVERRUN');
  assert.ok(blocker.fixes.length >= 2, 'blockers must come with executable fixes');
});

test('token ceilings that cannot be met are reported as block-level', () => {
  const fit = analyseFit({
    model: { id: 'cf', label: 'cf', outputCeiling: 512, contextWindow: 1600, quality: 7, speedTps: 200, quirks: [], freeTier: { rpm: 600 } },
    sizeTokens: 20_000, requestCount: 2, inputPerRequest: 1000,
  });
  assert.ok(fit.warnings.some((w) => w.code === 'CEILING_EXCEEDED' && w.severity === 'block'));
  assert.ok(fit.warnings.some((w) => w.code === 'CONTEXT_EXCEEDED'));
});

test('trains-on-data tiers are surfaced as a privacy warning', () => {
  const fit = analyseFit({
    model: { id: 'g', label: 'g', outputCeiling: 32_768, contextWindow: 1_000_000, quality: 9, speedTps: 150, quirks: [], freeTier: { rpm: 10, rpd: 1500, tpm: 1_000_000, trainsOnData: true } },
    sizeTokens: 6000, requestCount: 3, inputPerRequest: 2000,
  });
  assert.ok(fit.warnings.some((w) => w.code === 'TRAIN_ON_DATA'));
});

test('chunking respects both a per-chunk cap and a total-chunk cap', () => {
  const items = Array.from({ length: 40 }, (_, i) => i);
  const chunks = chunkItems(items, 4, 6);
  assert.ok(chunks.length <= 6);
  assert.equal(chunks.reduce((n, c) => n + c.items.length, 0), 40);
  for (const c of chunks) assert.ok(c.items.length >= 1);
});

test('stage budget converts expectations into a safe max_tokens parameter', () => {
  const ok = stageBudget({ model: { outputCeiling: 8192, contextWindow: 128_000, speedTps: 300 }, inputTokens: 3000, expectedOutputTokens: 6000 });
  assert.ok(ok.maxTokensParam <= 8192, 'never ask for more than the ceiling');
  assert.ok(ok.maxTokensParam > 6000, 'some headroom over the estimate is required');
  assert.equal(ok.overCeiling, false);
  assert.equal(ok.seconds, 20);
  const over = stageBudget({ model: { outputCeiling: 4096, contextWindow: 128_000, speedTps: 200 }, inputTokens: 1000, expectedOutputTokens: 6000 });
  assert.equal(over.overCeiling, true, 'a stage bigger than the ceiling must be flagged');
  assert.ok(over.maxTokensParam <= 4096);
});

test('token estimator is monotonic and kind-aware', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(400), 'code') > estimateTokens('a'.repeat(400), 'prose'));
  assert.ok(estimateOutputTokens(100) > estimateOutputTokens(50));
  assert.ok(pad(1000) > 1000);
  const cjk = estimateTokens('这是一个测试字符串');
  assert.ok(cjk >= 8 && cjk <= 10, `CJK should be roughly one token per char, got ${cjk}`);
});

test('lines round-trip through the output estimator within tolerance', () => {
  const lines = 180;
  const tokens = estimateOutputTokens(lines);
  const back = Math.round(tokens / 11);
  assert.ok(Math.abs(back - lines) <= 2);
});
