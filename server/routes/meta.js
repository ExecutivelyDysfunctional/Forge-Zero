/**
 * Read-only surface: what the engine knows. Kept separate from generation so the
 * UI can boot, render the catalogue and compose offline-ish endpoints without
 * touching anything stateful.
 */
import { Router } from 'express';
import { PROVIDERS, modelOptions, catalogMeta, recommendModels, recommendModel, fallbackChain, getModel, DEFAULT_MODEL_ID } from '../lib/catalog.js';
import { MODES, STACKS, CONSTITUTION, OUTPUT_PROTOCOL, CONTINUE_PROTOCOL, REPAIR_PROTOCOL } from '../lib/blueprint.js';
import { PRESETS, defaultSpec, normalizeSpec, AMBITIONS, CDN_LIBS, PERSISTENCE, LAYOUTS, AUTH_CHOICES, REALTIME_CHOICES, DEPLOY_CHOICES, TEST_CHOICES, MODE_SPEC_FIELDS } from '../lib/spec.js';
import { TOKENIZER_NOTE } from '../lib/tokenizer.js';
import { STRATEGIES } from '../lib/composer.js';
import { providerSummary } from '../lib/providers.js';
import { governorSnapshot } from '../lib/governor.js';
import { stats } from '../db.js';
import { config } from '../config.js';
import { sizeBudgetFor } from '../lib/budget.js';

const started = Date.now();

export const metaRouter = Router();

metaRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: config.version,
    env: config.env,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    db: true,
    stats: stats(),
    governor: governorSnapshot(),
    generateEnabled: config.allowGenerate,
  });
});

/** Everything the client needs to render the builder in one round trip. */
metaRouter.get('/bootstrap', (_req, res) => {
  res.json({
    version: config.version,
    defaultModelId: DEFAULT_MODEL_ID,
    providers: providerSummary(),
    models: modelOptions(),
    catalog: catalogMeta(),
    modes: Object.values(MODES).map((m) => ({
      id: m.id,
      label: m.label,
      tagline: m.tagline,
      stages: m.stages.map((s) => ({ id: s.id, title: s.title, kind: s.kind, purpose: s.purpose, maxLines: s.maxLines ?? null })),
      sizeByAmbition: m.sizeByAmbition,
      specFields: MODE_SPEC_FIELDS[m.id] ?? [],
    })),
    stacks: STACKS,
    ambitions: AMBITIONS,
    cdnLibs: CDN_LIBS,
    persistence: PERSISTENCE,
    layouts: LAYOUTS,
    authChoices: AUTH_CHOICES,
    realtimeChoices: REALTIME_CHOICES,
    deployChoices: DEPLOY_CHOICES,
    testChoices: TEST_CHOICES,
    presets: PRESETS.map((p) => ({ id: p.id, label: p.label, mode: p.mode, spec: p.spec })),
    strategies: STRATEGIES,
    constitution: CONSTITUTION.map(({ id, title, weight, applies, text }) => ({ id, title, weight, applies, preview: text.slice(0, 90) })),
    protocols: {
      output: OUTPUT_PROTOCOL,
      continue: CONTINUE_PROTOCOL,
      repair: REPAIR_PROTOCOL,
    },
    tokenizerNote: TOKENIZER_NOTE,
    specDefaults: { 'single-file': defaultSpec('single-file'), 'full-stack': defaultSpec('full-stack') },
    limits: { maxBriefChars: config.maxBriefChars },
  });
});

metaRouter.get('/constitution', (_req, res) => {
  res.json({ rules: CONSTITUTION, outputProtocol: OUTPUT_PROTOCOL });
});

/** "Which free model should I run this on?" - the same scorer the composer trusts. */
metaRouter.post('/models/recommend', (req, res) => {
  const { mode = 'single-file', spec, modelId } = req.body ?? {};
  const normalized = normalizeSpec({ ...(spec ?? {}), mode }, mode);
  if (!normalized.ok) return res.status(400).json({ ok: false, errors: normalized.errors, warnings: normalized.warnings });
  const modeDef = MODES[normalized.spec.mode];
  const size = sizeBudgetFor(modeDef, normalized.spec);
  const requests = Math.max(1, Math.ceil(size.tokens / 3000));
  const ranked = recommendModels({
    mode: normalized.spec.mode,
    targetOutputTokens: size.tokens,
    requestsNeeded: requests,
    inputTokensPerRequest: 2600,
  });
  res.json({
    ok: true,
    size,
    suggestedModelId: recommendModel({ mode: normalized.spec.mode, targetOutputTokens: size.tokens, requestsNeeded: requests, inputTokensPerRequest: 2600 }),
    current: modelId ? summarize(getModel(modelId)) : null,
    fallbacks: modelId ? fallbackChain(modelId, { mode: normalized.spec.mode, targetOutputTokens: size.tokens, requestsNeeded: requests, inputTokensPerRequest: 2600 }) : [],
    ranked: ranked.slice(0, 12),
  });
});

metaRouter.get('/models/:id', (req, res) => {
  const m = getModel(req.params.id, { provider: req.query.provider ?? null });
  res.json({ ok: true, model: summarize(m) });
});

metaRouter.get('/governor', (_req, res) => res.json({ ok: true, providers: governorSnapshot() }));

metaRouter.get('/providers', (_req, res) => {
  res.json({
    ok: true,
    providers: PROVIDERS.map((p) => ({
      id: p.id, label: p.label, family: p.family, keyUrl: p.keyUrl, docsUrl: p.docsUrl, tierNote: p.tierNote,
      models: p.models.map((m) => ({ id: m.id, label: m.label })),
    })),
  });
});

function summarize(m) {
  return {
    id: m.id, label: m.label, provider: m.provider, providerLabel: m.providerLabel, family: m.family,
    contextWindow: m.contextWindow, outputCeiling: m.outputCeiling, quality: m.quality, speedTps: m.speedTps,
    quirks: m.quirks, freeTier: m.freeTier, supports: m.supports, bestFor: m.bestFor, unverified: !!m.unverified,
    verifiedAt: m.verifiedAt, keyUrl: m.keyUrl, tierNote: m.tierNote,
  };
}
