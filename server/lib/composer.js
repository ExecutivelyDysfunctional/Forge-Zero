/**
 * The composer: brief + model profile + blueprint -> a runnable prompt pack.
 *
 * This is where the two axes of the product meet:
 *
 *   complexity toggle  ->  which blueprint (stages, ceilings, protocols)
 *   target model       ->  how much each stage may ask for, which rules survive,
 *                          which guard-rails get injected, and what you can afford
 *                          to spend against your daily free quota
 *
 * The output is *deterministic*: no network, no LLM, no randomness. Prompt
 * generation must be reproducible - if a build fails, you need to be able to
 * diff the prompt that caused it. Optional live execution happens elsewhere
 * (routes/generate.js) and never feeds back into composition.
 */

import { getModel, getProviderFor } from './catalog.js';
import { MODES } from './blueprint.js';
import { STACKS } from './blueprint.js';
import { CDN_LIBS, PERSISTENCE, LAYOUTS, AMBITIONS, acceptanceCriteria, seedCount } from './spec.js';
import { analyseFit, sizeBudgetFor, chunkItems, stageBudget, promptTokens, CEILING_SAFETY } from './budget.js';
import { estimateOutputTokens, estimateTokens } from './tokenizer.js';
import {
  OUTPUT_PROTOCOL, CONTRACT_REMINDER, QUIRK_RULES, constitutionText, REPAIR_PROTOCOL,
  CONTINUE_PROTOCOL,
} from './blueprint.js';

export const STRATEGIES = {
  auto: 'Decide from the model ceiling and the size of the artifact',
  oneshot: 'One request emits the whole artifact',
  'guided-oneshot': 'A JSON contract first, then one request for the whole artifact',
  staged: 'Every file group gets its own request, sized to the output ceiling',
};

const PRIOR_MANIFEST_TOKEN = '{{PRIOR_MANIFEST}}';

/** Top-level prompt assembly. Returns a PromptPack (see DESIGN.md §4). */
export function composePack({ mode, spec, modelId, options = {} }) {
  const modeDef = MODES[mode] ?? MODES['single-file'];
  const model = getModel(modelId, { provider: options.provider ?? null });
  const opts = normalizeOptions(options);
  const size = sizeBudgetFor(modeDef, spec);
  const extended = chooseRuleDepth({ model, size, opts });
  const acceptances = acceptanceCriteria(spec);

  const strategy = opts.strategy === 'auto'
    ? modeDef.stageStrategy({ model, sizeTokens: size.tokens, ambition: spec.ambition, spec })
    : opts.strategy;

  let plan = buildPlan({ modeDef, strategy, spec, model, size, opts });

  // Fit loop: measure the plan against the model, then apply mitigations until
  // it fits or we run out of things we are willing to sacrifice silently.
  const optimizations = [];
  const seen = new Set();
  let fit = null;
  for (let i = 0; i < 5; i++) {
    fit = measure({ plan, model, size, modeDef, spec });
    const blocker = fit.warnings.find((x) => x.severity === 'block');
    if (!blocker) break;
    const applied = applyMitigation(blocker, { plan, model, size, opts, modeDef, spec, optimizations, fit });
    if (!applied || seen.has(applied)) break;
    seen.add(applied);
    plan = reflow({ modeDef, strategy, spec, model, size, opts, plan });
  }

  const stages = renderStages({ plan, modeDef, spec, model, size, strategy, acceptances, extended, optimizations, opts });
  const recheck = measure({ plan, model, size, modeDef, spec });

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: modeDef.id,
    modeLabel: modeDef.label,
    strategy,
    strategyNote: strategyNote(strategy, model, size, recheck),
    spec,
    model: summarizeModel(model),
    provider: getProviderFor(model.id) ? summarizeProvider(getProviderFor(model.id), model) : null,
    sizeBudget: size,
    budget: recheck,
    stageCount: stages.length,
    stages,
    optimizations,
    systemHeader: buildSystemHeader({ modeDef, model, extended, size }),
    assembly: buildAssembly({ modeDef, strategy, stages, model }),
    repair: buildRepair({ modeDef, model, stages }),
    continuePrompt: CONTINUE_PROTOCOL,
    acceptance: acceptances,
    runContract: buildRunContract({ modeDef, spec, model, stages, recheck }),
    limits: {
      note: `Provider limits in this pack were verified ${model.verifiedAt ?? 'n/a'}. Free tiers change often: confirm in ${model.providerLabel ?? 'the provider console'} before trusting a number.`,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

function normalizeOptions(options) {
  return {
    strategy: STRATEGIES[options.strategy] ? options.strategy : 'auto',
    planFirst: options.planFirst !== false,
    includeAudit: options.includeAudit !== false,
    compactRules: ['auto', 'always', 'never'].includes(options.compactRules) ? options.compactRules : 'auto',
    includeRepair: options.includeRepair !== false,
    targetLines: Number.isFinite(options.targetLines) && options.targetLines > 0 ? Math.min(6000, options.targetLines) : null,
    extra: String(options.extra ?? '').slice(0, 4000),
  };
}

/**
 * How much of the behaviour contract survives. Long rule lists are the first
 * thing a small model ignores, and the first thing worth cutting when context
 * is tight - the artifact always matters more than the advice about it.
 */
function chooseRuleDepth({ model, size, opts }) {
  if (opts.compactRules === 'always') return false;
  if (opts.compactRules === 'never') return true;
  const perStage = Math.max(1, size.tokens / Math.max(1, expectedRequests(model, size)));
  const contextLoad = (perStage * 1.35) / model.contextWindow;
  if (contextLoad > 0.5) return false;
  if (model.quality < 6.8) return false;
  if (model.contextWindow < 32_000) return false;
  return true;
}

function expectedRequests(model, size) {
  const ceilingUsable = model.outputCeiling * CEILING_SAFETY;
  return Math.max(1, Math.ceil(size.tokens / ceilingUsable));
}

/* ------------------------------------------------------------------ *
 * Plan: which stages exist, and what each one covers
 * ------------------------------------------------------------------ */

function buildPlan({ modeDef, strategy, spec, model, size, opts }) {
  if (strategy === 'oneshot' || strategy === 'guided-oneshot') {
    const planStage = modeDef.stages.find((s) => s.kind === 'plan');
    const list = [];
    if (strategy === 'guided-oneshot' && planStage && opts.planFirst) {
      list.push({ stage: planStage, index: 0, chunk: null, files: [] });
    }
    list.push({
      stage: { id: 'oneshot', kind: 'oneshot-code', title: 'Complete artifact', maxLines: 0, purpose: null },
      index: list.length,
      chunk: null,
      files: modeDef.id === 'single-file' ? ['index.html'] : allProjectFiles(spec),
    });
    return { kind: 'single', stages: list };
  }

  let source = modeDef.stages.slice();
  if (!opts.planFirst) source = source.filter((s) => s.kind !== 'plan');
  if (!opts.includeAudit) source = source.filter((s) => s.kind !== 'audit');
  if (modeDef.id === 'single-file' && model.quirks.includes('terse')) {
    source = modeDef.stages.filter((s) => s.kind !== 'plan' || opts.planFirst);
  }

  const itemsByStage = expandRepeatables(modeDef, spec, model, size);
  const flat = [];
  for (const stage of source) {
    const chunks = itemsByStage.get(stage.id);
    if (!chunks) {
      flat.push({ stage, index: flat.length, chunk: null, files: defaultFilesFor(modeDef, stage, spec) });
    } else {
      for (const chunk of chunks) {
        flat.push({
          stage,
          index: flat.length,
          chunk,
          files: filesForChunk(modeDef, stage, chunk, spec),
        });
      }
    }
  }
  return { kind: 'staged', stages: flat };
}

/** Resources and views derived from the brief, used to chunk repeatable stages. */
function expandRepeatables(modeDef, spec, model, size) {
  const map = new Map();
  if (modeDef.id !== 'full-stack') return map;

  const resources = (spec.entities?.length ? spec.entities : [{ name: 'Item', fields: [] }])
    .map((e) => ({
      resource: e.name,
      endpoints: [
        { method: 'GET', path: `/api/${kebabPlural(e.name)}`, note: 'list with pagination + filters' },
        { method: 'POST', path: `/api/${kebabPlural(e.name)}`, note: 'create' },
        { method: 'GET', path: `/api/${kebabPlural(e.name)}/:id`, note: 'read one' },
        { method: 'PATCH', path: `/api/${kebabPlural(e.name)}/:id`, note: 'update' },
        { method: 'DELETE', path: `/api/${kebabPlural(e.name)}/:id`, note: 'delete' },
      ],
    }));

  const perRouteChunk = endpointsPerStage(model);
  const endpoints = resources.flatMap((r) => r.endpoints.map((e) => ({ ...e, resource: r.resource })));
  const groups = chunkItems(endpoints, perRouteChunk, 8);
  const routeStage = modeDef.stages.find((s) => s.id === 'routes');
  if (routeStage && groups.length) {
    map.set('routes', groups.map((g) => ({
      ...g,
      items: g.items,
      label: `endpoints ${g.label}`,
      resources: [...new Set(g.items.map((i) => i.resource))],
    })));
  }

  const viewNames = [...new Set([
    'dashboard',
    ...(spec.entities ?? []).map((e) => kebabPlural(e.name)),
    ...(spec.features ?? []).map(featureViewHint).filter(Boolean),
  ])].slice(0, 8);
  const perViewChunk = viewsPerStage(model);
  const viewGroups = chunkItems(viewNames, perViewChunk, 6);
  const viewStage = modeDef.stages.find((s) => s.id === 'client-views');
  if (viewStage && viewGroups.length) {
    map.set('client-views', viewGroups.map((g) => ({
      ...g,
      items: g.items.map((v) => ({ view: v })),
      label: `views ${g.label}`,
      views: g.items,
      first: g.index === 0,
    })));
  }
  void size;
  return map;
}

function endpointsPerStage(model) {
  // ~55 lines of handler per endpoint; stay inside the usable output ceiling.
  const usableLines = (model.outputCeiling * CEILING_SAFETY) / 11;
  return Math.max(2, Math.min(10, Math.floor(usableLines / 70)));
}

function viewsPerStage(model) {
  const usableLines = (model.outputCeiling * CEILING_SAFETY) / 11;
  return Math.max(1, Math.min(5, Math.floor(usableLines / 210)));
}

function defaultFilesFor(modeDef, stage, spec) {
  if (stage.kind === 'plan') return [];
  if (modeDef.id === 'single-file') return ['index.html'];
  const name = stage.id;
  if (name === 'foundation') return ['package.json', 'server/config.js', 'server/db.js', 'server/db/schema.sql', 'server/db/queries.js', 'shared/schema.js', '.env.example', '.gitignore', 'scripts/seed.js'];
  if (name === 'server-shell') return ['server/app.js', 'server/index.js', 'server/lib/envelope.js', 'server/lib/validate.js', 'server/middleware/index.js', 'client/index.html', 'client/src/api.js'];
  if (name === 'integration') return ['server/app.js'];
  if (name === 'verify') return ['tests/smoke.test.js', 'README.md'];
  return [];
}

/** Canonical file list handed to the model when it must emit everything at once. */
function allProjectFiles(spec) {
  return ['package.json', '.env.example', 'README.md', 'server/index.js', 'server/app.js', 'server/config.js',
    'server/db.js', 'server/db/schema.sql', 'server/db/queries.js', 'server/lib/envelope.js', 'server/lib/validate.js',
    'shared/schema.js', 'client/index.html', 'client/src/main.js', 'client/src/api.js', 'client/src/store.js',
    'client/src/router.js', 'client/src/styles/app.css', 'scripts/seed.js', 'tests/smoke.test.js']
    .concat(spec.entities?.length ? [...new Set(spec.entities.map((e) => `server/routes/${kebabPlural(e.name)}.js`))] : []);
}

function filesForChunk(modeDef, stage, chunk, spec) {
  if (stage.id === 'routes') {
    return [...new Set((chunk.resources ?? []).map((r) => `server/routes/${kebabPlural(r)}.js`))];
  }
  if (stage.id === 'client-views') {
    const shell = chunk.first ? ['client/src/store.js', 'client/src/router.js', 'client/src/main.js'] : [];
    return [...shell, ...(chunk.views ?? []).map((v) => `client/src/views/${kebab(v)}.js`)];
  }
  return defaultFilesFor(modeDef, stage, spec);
}

function stageFromId(modeDef, id, extra) {
  if (id !== 'oneshot') throw new Error('unknown stage ' + id);
  return { stage: { id: 'oneshot', kind: 'oneshot-code', title: extra.title, maxLines: 0 }, index: extra.index, chunk: null, files: [] };
}

function reflow({ modeDef, strategy, spec, model, size, opts, plan }) {
  // Re-running buildPlan after an option change (e.g. audit dropped) so stage
  // numbering and chunking stay consistent with what is actually emitted.
  const next = buildPlan({ modeDef, strategy, spec, model, size, opts });
  return next;
}

function measure({ plan, model, size, modeDef, spec }) {
  const inputPerRequest = estimateInputPerRequest(modeDef, spec, model);
  const repairReserve = model.quality >= 8 ? 1 : Math.max(2, Math.round(plan.stages.length * 0.5));
  return analyseFit({
    model,
    sizeTokens: size.tokens,
    requestCount: plan.stages.length,
    inputPerRequest,
    repairReserve,
  });
}

function estimateInputPerRequest(modeDef, spec, model) {
  const header = buildSystemHeader({ modeDef, model, extended: true, size: { tokens: 0 } });
  const brief = renderBrief({ modeDef, spec, model });
  return estimateTokens(header, 'mixed') + estimateTokens(brief, 'mixed') + 260;
}

/* ------------------------------------------------------------------ *
 * Mitigations - applied instead of shipping a pack that cannot run
 * ------------------------------------------------------------------ */

const MITIGATION_ORDER = {
  CEILING_EXCEEDED: ['increase-parts', 'set-ambition'],
  CONTEXT_EXCEEDED: ['compact-constitution', 'reduce-features'],
  RPD_OVERRUN: ['drop-stage', 'set-ambition'],
  TPD_OVERRUN: ['set-ambition', 'increase-parts'],
};

function applyMitigation(blocker, ctx) {
  const { opts, optimizations, plan } = ctx;
  const order = MITIGATION_ORDER[blocker.code] ?? [];
  for (const action of order) {
    switch (action) {
      case 'increase-parts':
        if (opts.strategy === 'oneshot' || opts.strategy === 'guided-oneshot') {
          opts.strategy = 'staged';
          optimizations.push({
            code: 'auto-strategy-staged',
            title: 'Switched to staged execution',
            detail: `A single reply cannot hold ${ctx.size.tokens} output tokens on a ${ctx.model.outputCeiling}-token ceiling, so one-shot mode was overridden. Each stage is now sized to fit and the CONTINUE protocol covers the rest.`,
            triggeredBy: blocker.code,
          });
          return 'strategy';
        }
        if (ctx.modeDef.id === 'full-stack') {
          const before = plan.stages.length;
          ctx.routeLimit = true;
          optimizations.push({
            code: 'finer-chunks',
            title: 'Endpoint and view groups made smaller',
            detail: `Repetable stages were re-chunked so every reply stays under ${Math.floor(ctx.model.outputCeiling * CEILING_SAFETY)} tokens. Stages went from ${before} to a size that fits.`,
            triggeredBy: blocker.code,
          });
          return 'chunks';
        }
        return null;
      case 'compact-constitution':
        if (opts.compactRules !== 'always') {
          opts.compactRules = 'always';
          optimizations.push({
            code: 'compact-rules',
            title: 'Behaviour contract compressed to core rules',
            detail: `${ctx.model.contextWindow} tokens of context cannot hold the full contract plus the accumulated files. Extended rules were dropped and only the load-bearing core survives into every stage - a shorter contract a model actually follows beats a complete one it ignores.`,
            triggeredBy: blocker.code,
          });
          return 'rules';
        }
        return null;
      case 'drop-stage':
        if (blocker.fixes?.some((f) => f.params?.stageId === 'audit') && opts.includeAudit) {
          opts.includeAudit = false;
          optimizations.push({
            code: 'dropped-audit',
            title: 'Audit stage removed',
            detail: 'Your daily request budget does not cover a self-review pass. Drop it for the first run; if the output misbehaves, re-generate this pack with the audit stage on and spend the repair requests instead.',
            triggeredBy: blocker.code,
          });
          return 'audit';
        }
        return null;
      case 'set-ambition':
        if (ctx.spec.ambition !== 'mvp') {
          optimizations.push({
            code: 'ambition-flagged',
            title: 'Ambition left unchanged on purpose',
            detail: 'Cutting scope silently is how a tool ends up shipping an app the user did not ask for. The brief stays as written; the blocker is reported so you can decide. Lower the ambition yourself if you want a smaller pack.',
            triggeredBy: blocker.code,
          });
          return null;
        }
        return null;
      case 'reduce-features':
        return null;
      default:
        return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderStages({ plan, modeDef, spec, model, size, strategy, acceptances, extended, optimizations, opts }) {
  const total = plan.stages.length;
  return plan.stages.map((entry, i) => {
    const stage = entry.stage;
    const isOneshot = stage.id === 'oneshot';
    const isPlan = stage.kind === 'plan';
    const ctx = {
      model,
      spec,
      stage: { maxLines: stage.maxLines ?? 0 },
      sizeBudget: size,
      chunk: entry.chunk,
      files: entry.files,
      index: i,
      total,
      strategy,
      opts,
    };
    const instruction = isOneshot ? modeDef.oneshot(ctx) : stage.instruction ? stage.instruction(ctx) : '';
    const maxLines = perStageLines(model, size, total, stage, isOneshot);
    const expectedOutputTokens = isPlan
      ? Math.min(stage.maxTokens ?? 900, Math.floor(model.outputCeiling * 0.35))
      : Math.min(Math.round(estimateOutputTokens(maxLines)), Math.max(512, Math.ceil(size.tokens / total)));

    const system = [
      buildSystemHeader({ modeDef, model, extended, size }),
      '',
      modelAdaptations(model, { maxLines, parts: Math.max(1, Math.ceil(size.tokens / Math.max(1, model.outputCeiling * CEILING_SAFETY))) }),
    ].filter(Boolean).join('\n');

    const userParts = [
      renderBrief({ modeDef, spec, model }),
      '',
      renderStageBlock({ modeDef, entry, i, total, instruction, maxLines, isPlan, isOneshot, model, spec, acceptances, extended }),
      '',
      isPlan ? planReminder() : CONTRACT_REMINDER,
    ];
    const user = userParts.join('\n');
    const contextBlock = i === 0
      ? ''
      : [
          '<EXISTING_FILES>',
          `The files below already exist from earlier stages. Do not restate them. ${PRIOR_MANIFEST_TOKEN}`,
          '</EXISTING_FILES>',
        ].join('\n');

    const tokens = promptTokens(system, user, contextBlock);
    const budget = stageBudget({ model, inputTokens: tokens.input, expectedOutputTokens });
    const sampling = samplingFor(model, stage.kind, isPlan);

    return {
      index: i,
      ordinal: `${i + 1} of ${total}`,
      id: isOneshot ? 'complete-artifact' : stage.id + (entry.chunk ? `:g${entry.chunk.index}` : ''),
      baseId: stage.id,
      title: (stage.title ?? 'Complete artifact') + (entry.chunk ? ` — ${entry.chunk.label}` : ''),
      kind: stage.kind ?? 'code',
      purpose: stage.purpose ?? 'Emit the whole artifact in a single reply, sized to the ceiling you have.',
      deliverable: isPlan
        ? 'JSON contract (parsed by the workbench, never pasted into the project)'
        : modeDef.id === 'full-stack'
          ? (entry.files.length ? entry.files.join(', ') : 'the complete project tree')
          : 'index.html',
      files: entry.files,
      chunk: entry.chunk?.items ?? null,
      system,
      user,
      contextBlock,
      instruction,
      maxTokens: budget.maxTokensParam,
      expectedOutputTokens,
      maxLines,
      tokens,
      budget,
      params: sampling,
      copyText: joinPrompt(system, user, contextBlock),
      postflight: postflightFor({ modeDef, isPlan, model }),
    };
  });
}

function perStageLines(model, size, total, stage, isOneshot) {
  const ceilingLines = Math.floor((model.outputCeiling * CEILING_SAFETY) / 11);
  if (isOneshot) return Math.max(80, size.lines);
  const share = Math.max(60, Math.ceil(size.lines / Math.max(1, total)));
  if (stage.maxLines) return Math.min(ceilingLines, stage.maxLines);
  return Math.min(ceilingLines, share);
}

function buildSystemHeader({ modeDef, model, extended, size }) {
  const role = modeDef.id === 'single-file'
    ? 'You are a senior front-end engineer executing one stage of an automated build pipeline. Your output is written verbatim into a file by a script. There is no human reading this, no chat, and no second chance at formatting.'
    : 'You are a senior full-stack engineer executing one stage of an automated build pipeline. Your output is written verbatim into project files by a script. There is no human reading this; a wrong import path or an invented dependency breaks the build.';
  return [
    role,
    '',
    `TARGET MODEL: ${model.label} (${model.providerLabel}). Context ${fmtTokens(model.contextWindow)}; hard per-response output ceiling ${fmtTokens(model.outputCeiling)}.`,
    `ARTIFACT: ${modeDef.label} — ${modeDef.tagline}`,
    `The whole build is planned for ~${fmtTokens(size.tokens)} of output. Budget accordingly: your stage is a slice, not the project.`,
    '',
    modeDef.ceiling,
    '',
    OUTPUT_PROTOCOL,
    '',
    constitutionText(modeDef.applies, { extended }),
    '',
    modeDef.shape,
  ].join('\n');
}

/** Every quirk-driven paragraph the selected model triggered, in one block. */
function modelAdaptations(model, { maxLines, parts }) {
  const blocks = [];
  for (const code of model.quirks ?? []) {
    const rule = QUIRK_RULES[code];
    if (!rule) continue;
    blocks.push(typeof rule === 'function' ? rule({ maxLines, parts }) : rule);
  }
  if (!blocks.length) return '';
  return ['## MODEL-SPECIFIC ADAPTATIONS', '', ...blocks.map((b) => b + '\n')].join('\n');
}

function renderBrief({ modeDef, spec, model }) {
  const L = [];
  L.push('# BRIEF');
  L.push('');
  L.push(`Project: ${spec.name}`);
  L.push(`Promise: ${spec.idea}`);
  if (spec.audience) L.push(`Who uses it: ${spec.audience}`);
  L.push(`Ambition: ${AMBITIONS[spec.ambition]?.label ?? spec.ambition} — ${AMBITIONS[spec.ambition]?.blurb ?? ''}`);
  L.push('');
  if (spec.features.length) {
    L.push('## Features (each one must exist in code and be reachable)');
    spec.features.forEach((f, i) => L.push(`${i + 1}. ${f}`));
    L.push('');
  }
  if (spec.entities.length) {
    L.push('## Data model');
    for (const e of spec.entities) {
      L.push(`- ${e.name}${e.fields?.length ? `: ${e.fields.map((f) => `${f.name}:${f.type}`).join(', ')}` : ' (shape is yours; state it in the contract)'}`);
    }
    L.push('');
  } else if (modeDef.id === 'full-stack') {
    L.push('## Data model');
    L.push('Not specified. Declare it in the architecture contract and keep every later stage inside that declaration.');
    L.push('');
  }
  if (spec.mustHave.length) { L.push('## Non-negotiables'); spec.mustHave.forEach((m) => L.push(`- ${m}`)); L.push(''); }
  if (spec.avoid.length) {
    L.push('## Explicitly out of scope (do not add these, however tempting)');
    spec.avoid.forEach((m) => L.push(`- ${m}`));
    L.push('');
  }
  if (spec.notes) { L.push('## Notes from the author'); L.push(spec.notes); L.push(''); }

  if (modeDef.id === 'single-file') {
    const s = spec.single ?? {};
    L.push('## Single-file constraints for this build');
    L.push(`- Persistence: ${PERSISTENCE[s.persistence] ?? PERSISTENCE.local}`);
    L.push(`- Layout priority: ${s.layout ?? 'both'} — ${LAYOUTS[s.layout] ?? LAYOUTS.both}`);
    L.push(`- Offline: ${s.offlineFirst === false ? 'network assumed available' : 'must be fully usable with no network at all'}`);
    L.push(`- Keyboard shortcuts: ${s.keyboardShortcuts ? 'yes, and discoverable via a "?" sheet' : 'not required'}`);
    L.push(`- Share/export: ${s.shareData ? 'download + re-import the full state as one JSON file, with a schemaVersion guard' : 'not required'}`);
    if (s.allowCdn?.length) {
      L.push(`- Allowed CDN libraries (pinned, feature-detected, with fallback):`);
      s.allowCdn.forEach((k) => {
        const lib = CDN_LIBS[k];
        if (lib) L.push(`    ${lib.label}  ${lib.url}  (global: ${lib.global})`);
      });
    } else {
      L.push('- Allowed CDN libraries: NONE. Zero external requests. Anything you need is written by you.');
    }
    L.push(`- Seed records on first run: ${seedCount(spec)}`);
  } else {
    const st = spec.stack ?? {};
    const stack = STACKS[st.stackId] ?? STACKS['node-express-sqlite'];
    L.push('## Stack (fixed, do not substitute)');
    L.push(`- ${stack.label} — runtime ${stack.runtime}`);
    L.push(`- Dependencies: ${stack.deps.join(', ')}`);
    L.push(`- Data: ${stack.db}`);
    L.push(`- Frontend: ${stack.frontend}`);
    L.push(`- Notes: ${stack.notes}`);
    L.push(`- Auth: ${st.auth ?? 'none'}`);
    L.push(`- Realtime: ${st.realtime ?? 'none'}`);
    L.push(`- Deploy target: ${st.deploy ?? 'local'}`);
    L.push(`- Tests: ${st.tests ?? 'smoke'}`);
    L.push(`- Seed volume: ${st.seedVolume ?? 40} rows per table`);
    L.push(`- Multi-user: ${st.multiUser ? 'yes, scoped by session' : 'no, one workspace'}`);
  }
  L.push('');
  L.push(`## Acceptance (the build is judged on this list)`);
  acceptancesOf(spec).forEach((a, i) => L.push(`${i + 1}. ${a}`));
  return L.join('\n');

  function acceptancesOf() { return acceptanceCriteria(spec); }
  void model;
}

function renderStageBlock({ modeDef, entry, i, total, instruction, maxLines, isPlan, isOneshot, spec, acceptances, extended, stage }) {
  const realStage = entry.stage;
  const parts = [];
  parts.push(`# STAGE ${i + 1} OF ${total}${realStage.title ? ` — ${realStage.title}` : ''}`);
  parts.push('');
  if (!isOneshot && realStage.purpose) {
    parts.push('## Why this stage exists');
    parts.push(realStage.purpose);
    parts.push('');
  }
  parts.push('## What to produce');
  parts.push(instruction);
  parts.push('');
  if (!isPlan) {
    parts.push('## Stage budget');
    parts.push(`- Ceiling for this reply: ${maxLines} lines (~${estimateOutputTokens(maxLines)} tokens). Plan the split before writing.`);
    parts.push('- Files owned by this stage: ' + (entry.files.length ? entry.files.join(', ') : 'index.html'));
    parts.push('- Anything you decide that is not in the brief: choose the boring option and put it in a one-line comment.');
    parts.push('');
    parts.push('## Definition of done for this stage');
    parts.push(...acceptances.slice(0, extended ? 8 : 4).map((a) => `- ${a}`));
  } else {
    parts.push('## Stage budget');
    parts.push('- This is the only stage where prose is allowed, and only as JSON values. Keep it under ' + maxLines + ' lines.');
    parts.push('- Your contract is binding on every later stage; ambiguity here becomes a rebuild.');
  }
  if (i > 0) {
    parts.push('');
    parts.push('## Handoff');
    parts.push(`Previous stages produced: ${PRIOR_MANIFEST_TOKEN}`);
    parts.push('Build on those symbols exactly as named there. If a needed symbol is missing, say so with @BLOCKED instead of redefining it.');
  }
  if (modeDef.id === 'full-stack' && !isPlan && spec.features.length && i === total - 1) {
    parts.push('');
    parts.push('Final stage: restate nothing, change only what the checklist proves is broken.');
  }
  void stage;
  return parts.join('\n');
}

function planReminder() {
  return [
    '## CONTRACT (binding, restated)',
    '- Valid JSON only. No comments, no trailing commas, no fence, no prose before or after.',
    '- Every key listed above must be present, even if its array is empty.',
    '- Names you invent here are law for the next stages: ids, fields, routes, file paths.',
    '- If the brief is silent on something required, decide it now and record the decision in "risks".',
  ].join('\n');
}

function joinPrompt(system, user, context) {
  const parts = [
    '=== SYSTEM ===',
    system,
    '',
    '=== USER ===',
    user,
  ];
  if (context) parts.push('', '=== CONTEXT (append when running; the workbench injects it) ===', context);
  return parts.join('\n');
}

function samplingFor(model, kind, isPlan) {
  const base = model.sampling ?? { temperature: 0.2 };
  let temperature = base.temperature ?? 0.2;
  if (isPlan) temperature = Math.min(temperature, 0.2);
  if (kind === 'audit') temperature = 0;
  if (model.quirks?.includes('terse')) temperature = Math.min(temperature, 0.15);
  return {
    temperature: Number(temperature.toFixed(2)),
    ...(model.supports?.topP && base.topP != null ? { top_p: base.topP } : {}),
    max_tokens: 'stage-computed',
    stream: true,
  };
}

function postflightFor({ modeDef, isPlan, model }) {
  const common = [
    'First line is a FILE header (or `{` for plan stages)',
    'No TODO / "for brevity" / ellipsis anywhere',
    'No credential-looking literals in the output',
  ];
  if (isPlan) return ['Parses as JSON', 'All required keys present', ...common.slice(1)];
  const modeChecks = modeDef.id === 'single-file'
    ? ['<html> and </html> both present', 'Brace and paren balance in the whole file', 'Every id referenced in JS exists in markup']
    : ['Every emitted file starts with its own header', 'Imports resolve to manifest entries or pinned deps'];
  const truncation = model.quirks?.includes('truncation')
    ? ['Truncation check is mandatory here: this model stops mid-file and claims it is done']
    : ['Detect CONTINUE marker and queue the continuation automatically'];
  return [...common, ...modeChecks, ...truncation];
}

function strategyNote(strategy, model, size, fit) {
  const ceiling = Math.floor(model.outputCeiling * CEILING_SAFETY);
  if (strategy === 'oneshot') {
    return `One request is enough: ~${fmtTokens(size.tokens)} of code against a ${fmtTokens(ceiling)} usable ceiling on ${model.label}. Nothing is split, so nothing needs stitching.`;
  }
  if (strategy === 'guided-oneshot') {
    return `A JSON contract first (it costs ~900 tokens and prevents the expensive mistakes), then the whole artifact in one reply. Chosen because ${model.label} holds ${fmtTokens(ceiling)} per response and the artifact is ~${fmtTokens(size.tokens)}.`;
  }
  return `Staged across ${fit.parts} requests because ~${fmtTokens(size.tokens)} of code exceeds the ${fmtTokens(ceiling)} usable output ceiling on ${model.label}. Each stage ends at a file or section boundary so a truncated reply is still recoverable.`;
}

function buildAssembly({ modeDef, strategy, stages, model }) {
  return {
    strategy,
    stitch: modeDef.id === 'single-file'
      ? [
          'Create index.html, then paste each stage output in order.',
          'Where a stage emits @REPLACE, swap the marked block instead of appending.',
          'A reply ending in <<CONTINUE>> means "paste the next reply here" - do not let a gap form.',
          'Finish by opening the file from disk (file://), not from a server: that is the target.',
        ]
      : [
          'Create the project folder, then paste files in stage order.',
          'npm install, cp .env.example .env, then run the migrate + seed scripts named in the README stage.',
          'Run the smoke test before opening a browser; it catches most stitching errors in seconds.',
          'If a stage emitted @REPLACE, overwrite that file rather than appending.',
        ],
    stageCount: stages.length,
    resumeHint: `Re-run only the failed stage with the same contract. Do not restart the build: the earlier stages are already correct, and re-rolling them is how a free key dies at 80% done.`,
    verifyCommand: modeDef.id === 'single-file'
      ? 'open index.html && check the browser console is empty'
      : 'npm test && npm run dev',
    modelNote: `${model.label}: ${fmtTokens(model.outputCeiling)} max output per response, ${fmtTokens(model.contextWindow)} context${model.freeTier?.rpd ? `, ${model.freeTier.rpd} requests/day free` : ''}.`,
  };
}

function buildRepair({ modeDef, model, stages }) {
  const stageIds = stages.map((s) => s.id);
  return {
    protocol: REPAIR_PROTOCOL,
    appliesTo: stageIds,
    modelNote: model.quirks?.includes('truncation')
      ? 'This model truncates: when the failure is a half-written file, the correct repair is a CONTINUE, not a rewrite. The verify step distinguishes them.'
      : 'Paste the whole error, not the last line; free models misclassify truncated traces as logic bugs.',
    slots: ['stageId', 'stageOutput', 'failure', 'attemptNumber'],
    maxChars: 24_000,
    note: 'Failure text is truncated to a bounded window around the error before it reaches a prompt, both for token economy and because pasted logs are an injection vector.',
  };
}

function buildRunContract({ modeDef, spec, model, stages, recheck }) {
  const stack = modeDef.id === 'full-stack' ? STACKS[spec.stack?.stackId] ?? null : null;
  const schedule = recheck.minSpacingSec > 0
    ? `Send one stage every ${recheck.minSpacingSec}s minimum (from the ${model.freeTier?.rpm} RPM free limit). Estimated wall clock for a clean run: ~${recheck.etaMinutes} min.`
    : 'No published per-minute limit for this endpoint; the server governor still serialises requests.';
  return {
    commands: modeDef.id === 'single-file'
      ? ['(optional) npx serve .   # only to check it also works over http', 'open index.html']
      : stack ? ['npm install', 'cp .env.example .env', 'npm run migrate', 'npm run seed', 'npm run dev', 'npm test'] : [],
    schedule,
    requests: `${stages.length} stages + ~${Math.max(1, Math.round(stages.length * 0.6))} expected repairs`,
    dailyBudget: recheck.rpdPct == null ? 'not published' : `~${recheck.projectedRequests} of ${model.freeTier?.rpd ?? '?'} requests/day (${recheck.rpdPct}%)`,
    tokenBudget: recheck.tpdPct == null ? 'no daily token cap published' : `~${recheck.projectedTokens} of ${model.freeTier?.tpd} tokens/day (${recheck.tpdPct}%)`,
    fallbacks: recheck.fits ? [] : ['A second free key on a different provider (see the model picker fallback chain)'],
  };
}

function summarizeModel(model) {
  return {
    id: model.id, label: model.label, provider: model.provider, providerLabel: model.providerLabel,
    contextWindow: model.contextWindow, outputCeiling: model.outputCeiling, quality: model.quality,
    speedTps: model.speedTps, quirks: model.quirks, freeTier: model.freeTier, sampling: model.sampling,
    supports: model.supports, bestFor: model.bestFor, verifiedAt: model.verifiedAt, unverified: !!model.unverified,
    tierNote: model.tierNote, keyUrl: model.keyUrl, docsUrl: model.docsUrl, family: model.family,
  };
}

function summarizeProvider(p, model) {
  return { id: p.id, label: p.label, family: p.family, baseUrl: p.baseUrl, keyUrl: p.keyUrl, docsUrl: p.docsUrl, authHeader: p.authHeader, tierNote: p.tierNote, modelId: model.id };
}

const fmtTokens = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n));

/* ------------------------------------------------------------------ *
 * Small string helpers used by chunking
 * ------------------------------------------------------------------ */

export function kebab(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
}

export function kebabPlural(name) {
  const k = kebab(name);
  if (!k) return 'items';
  if (/(s|x|z|ch|sh)$/.test(k)) return k + 'es';
  if (/[^aeiou]y$/.test(k)) return k.slice(0, -1) + 'ies';
  return k + 's';
}

function featureViewHint(feature) {
  const m = /^(dashboard|settings|calendar|board|inbox|reports?|analytics|export|import|profile)\b/i.exec(feature);
  return m ? kebab(m[1]) : null;
}
