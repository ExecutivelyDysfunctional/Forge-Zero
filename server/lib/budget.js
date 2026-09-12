/**
 * Budget arithmetic: can this plan actually be executed with this free key?
 *
 * Two ceilings decide it, and they are different in kind from the ones paid
 * models impose:
 *
 *   - **outputCeiling** - tokens a single response may contain. Exceed it and the
 *     model does not warn you; it just stops mid-file.
 *   - **freeTier.rpd / tpm** - requests and tokens you may spend today. Exceed
 *     them and the build dies at stage 6 of 9 with a 429, typically an hour from
 *     now with no way to resume on the same key.
 *
 * So every pack is measured against both, and the fit result either passes the
 * plan through or returns a mitigation the composer can apply automatically.
 */

import { estimateTokens, estimateOutputTokens, pad } from './tokenizer.js';
import { AMBITIONS } from './spec.js';
import { listModels, DEFAULT_MODEL_ID } from './catalog.js';

/** Usable share of a model's per-response ceiling; the rest is safety margin. */
export const CEILING_SAFETY = 0.82;
/** Share of the context window we let input + expected output occupy. */
export const CONTEXT_SAFETY = 0.78;
/** Beyond this many stages a "plan" is a project-management problem, not a prompt problem. */
export const MAX_PARTS_DEFAULT = 24;

/**
 * Estimate how large the requested artifact is, in lines and output tokens.
 * Ambition sets the baseline; features and entities add to it because each one
 * is another code path the model must actually write.
 */
export function sizeBudgetFor(modeDef, spec) {
  const ambition = AMBITIONS[spec.ambition] ?? AMBITIONS.polished;
  let lines = modeDef.sizeByAmbition[spec.ambition] ?? 620;
  lines += Math.max(0, spec.features.length - 3) * 34;
  lines += spec.entities.reduce((sum, e) => sum + 18 + (e.fields?.length ?? 0) * 9, 0);
  if (modeDef.id === 'full-stack') {
    if (spec.stack?.auth && spec.stack.auth !== 'none') lines += 140;
    if (spec.stack?.tests !== 'none') lines += 120;
    if (spec.stack?.realtime && spec.stack.realtime !== 'none') lines += 90;
    lines += 240; // README + config + envelope + shared schema overhead
  } else {
    if (spec.single?.allowCdn?.length) lines += 22 * spec.single.allowCdn.length;
  }
  lines = Math.round(Math.min(4200, Math.max(120, lines)));
  return {
    lines,
    tokens: estimateOutputTokens(lines),
    rawTokens: estimateOutputTokens(lines),
    ambition: ambition.label,
  };
}

/**
 * Split work items into chunks small enough for one response.
 * @param {Array} items
 * @param {number} maxItems
 * @param {number} [maxTotal] hard cap on chunks (rate-limit driven)
 */
export function chunkItems(items, maxItems, maxTotal = 8) {
  if (!items.length) return [];
  // Hard constraint: each chunk fits one reply. Soft constraint: do not explode
  // the stage count. When they conflict, grow the chunks and let the fit
  // analysis report the ceiling problem - that is a real signal, not something
  // to hide by dropping work on the floor.
  let per = maxItems;
  if (Math.ceil(items.length / per) > maxTotal) per = Math.ceil(items.length / maxTotal);
  per = Math.max(1, per);
  const out = [];
  for (let i = 0; i < items.length; i += per) {
    out.push({ index: out.length, items: items.slice(i, i + per), label: `${i + 1}-${Math.min(items.length, i + per)}` });
  }
  return out;
}

/**
 * Full fit analysis for a pack.
 *
 * @param {object} args
 * @param {object} args.model            enriched catalogue profile
 * @param {number} args.sizeTokens       expected total output tokens
 * @param {number} args.requestCount     requests the plan needs (incl. repairs)
 * @param {number} args.inputPerRequest  typical input tokens per request
 * @param {number} [args.repairReserve]  extra requests assumed for fixes
 */
export function analyseFit({ model, sizeTokens, requestCount, inputPerRequest, repairReserve = 0 }) {
  const warnings = [];
  const ceilingUsable = Math.floor(model.outputCeiling * CEILING_SAFETY);
  const ft = model.freeTier ?? {};

  // ---- output ceiling -------------------------------------------------
  const partsNeeded = Math.max(1, Math.ceil(sizeTokens / ceilingUsable));

  /*
   * Splitting is not free. Every extra part is another rate-limited request on a
   * key with a daily cap, so "just split it more" is only advice up to the point
   * where the plan becomes absurd. Past that the honest answer is: this model
   * cannot build this artifact, and no wording in the prompt changes that.
   */
  const affordableParts = ft.rpd
    ? Math.max(requestCount, Math.floor(ft.rpd * 0.4))
    : Math.max(requestCount, MAX_PARTS_DEFAULT);
  let parts = Math.max(requestCount, partsNeeded);
  const partsCapped = parts > affordableParts;
  if (partsCapped) parts = affordableParts;
  const perStageFinal = Math.ceil(sizeTokens / parts);

  const ceilingUtil = perStageFinal / model.outputCeiling;
  if (perStageFinal > ceilingUsable || partsCapped) {
    warnings.push(w('CEILING_EXCEEDED', 'block',
      `This model cannot emit ${fmtN(sizeTokens)} tokens of code in ${parts} request${parts === 1 ? '' : 's'}`,
      `Each part would need ${fmtN(perStageFinal)} output tokens against a usable ceiling of ${fmtN(ceilingUsable)} (${fmtN(model.outputCeiling)} hard).`
      + (partsCapped ? ` Splitting further would blow past ${ft.rpd ? `the ${ft.rpd} requests/day free allowance` : 'a workable number of stages'}.` : ' Left alone, the stage truncates and the file lands unusable.'),
      fix('Pick a model with a bigger output ceiling', 'set-model', { modelId: 'gemini-3-flash' }),
      fix('Lower ambition', 'set-ambition', { ambition: 'mvp' })));
  } else if (ceilingUtil > 0.7) {
    warnings.push(w('CEILING_TIGHT', 'warn',
      'One stage is close to the per-response output ceiling',
      `${Math.round(ceilingUtil * 100)}% of ${model.outputCeiling} tokens. The CONTINUE protocol will very likely fire, which is survivable but costs a request per split.`,
      fix('Add spare parts', 'increase-parts')));
  }


  // ---- context window -------------------------------------------------
  const contextNeed = inputPerRequest + perStageFinal * 1.35; // + generated files carried forward
  const contextPct = (contextNeed / model.contextWindow) * 100;
  if (contextPct > 100) {
    warnings.push(w('CONTEXT_EXCEEDED', 'block',
      'Later stages would exceed the context window',
      `Input plus the files already emitted is ~${Math.round(contextNeed)} tokens against ${model.contextWindow}. The model will silently forget the earliest files - usually the schema.`,
      fix('Shorter contract', 'compact-constitution'), fix('Trim features', 'reduce-features')));
  } else if (contextPct > 78) {
    warnings.push(w('CONTEXT_PRESSURE', 'warn',
      'Context pressure on the later stages',
      `~${Math.round(contextPct)}% of the window is committed by the final stages. The extended rules are being dropped to keep room for the actual files.`,
      fix('Shorter contract', 'compact-constitution')));
  }

  // ---- daily request budget ------------------------------------------
  const totalRequests = parts + repairReserve;
  const projected = totalRequests * 1.6; // assume ~60% of stages need one repair
  let rpdPct = null;
  if (ft.rpd) {
    rpdPct = (projected / ft.rpd) * 100;
    if (rpdPct > 100) {
      warnings.push(w('RPD_OVERRUN', 'block',
        `This plan needs ~${projected} requests; the free key allows ${ft.rpd}/day`,
        `Building it today means stopping at stage ${Math.max(1, Math.floor((ft.rpd / projected) * parts))} with no way to resume on the same key.`,
        fix('Drop the audit stage', 'drop-stage', { stageId: 'audit' }),
        fix('Pick a model with more RPD', 'set-model', { modelId: highestRpdModelId() }),
        fix('Cut to MVP', 'set-ambition', { ambition: 'mvp' })));
    } else if (rpdPct > 45) {
      warnings.push(w('RPD_TIGHT', 'warn',
        `Uses ${Math.round(rpdPct)}% of the daily request budget`,
        `~${projected} of ${ft.rpd} free requests, counting repairs. Fine if nothing breaks; there is little room to re-run a stage.`,
        fix('Drop the audit stage', 'drop-stage', { stageId: 'audit' })));
    }
  } else {
    warnings.push(w('NO_RPD_KNOWN', 'info',
      'No published daily request cap for this model',
      'Rate limits are tracked live by the server governor instead. Unlimited in the catalog is not the same as unlimited in practice - check the provider console.',
      null));
  }

  // ---- token/day and tokens/minute -----------------------------------
  const dayTokens = (inputPerRequest + perStageFinal) * totalRequests;
  let tpdPct = null;
  if (ft.tpd) {
    tpdPct = (dayTokens / ft.tpd) * 100;
    if (tpdPct > 100) {
      warnings.push(w('TPD_OVERRUN', 'block',
        'Exceeds the free daily token allowance',
        `~${Math.round(dayTokens)} tokens against a ${ft.tpd}/day budget. Split the build across days at a stage boundary, or switch to a provider with a larger allowance (Cerebras allows ~1M/day).`,
        fix('Switch provider', 'set-model', { modelId: 'gpt-oss-120b', provider: 'cerebras' })));
    } else if (tpdPct > 55) {
      warnings.push(w('TPD_PRESSURE', 'warn',
        `Consumes ${Math.round(tpdPct)}% of today's token allowance`,
        `~${Math.round(dayTokens)} of ${ft.tpd} tokens on this model. Budget the rest of your day accordingly.`));
    }
  }

  const minutesFromTpm = ft.tpm ? dayTokens / ft.tpm : null;
  const minutesFromSpeed = model.speedTps ? dayTokens / model.speedTps / 60 : null;
  const etaMinutes = Math.max(minutesFromTpm ?? 0, minutesFromSpeed ?? 0);
  if (minutesFromTpm && minutesFromTpm > 15) {
    warnings.push(w('TPM_THROUGHPUT', 'warn',
      'Throttled by tokens-per-minute, not by the model',
      `At ${ft.tpm} TPM the pack needs ~${minutesFromTpm.toFixed(0)} minutes of pure throughput - generation speed is irrelevant here. Plan the build as a coffee break, not a paste-and-go.`));
  }

  // ---- spacing ---------------------------------------------------------
  const minSpacingSec = ft.rpm ? Math.ceil(60 / ft.rpm) : 0;

  // ---- behavioural ------------------------------------------------------
  const q = new Set(model.quirks ?? []);
  if (q.has('truncation')) {
    warnings.push(w('TRUNCATION_PRONE', 'warn',
      'This model truncates long files; the pack is sized to split, not to fit',
      `Parts are capped at ~${Math.floor(ceilingUsable * 0.85)} output tokens and the CONTINUE protocol is armed on every stage.`, null));
  }
  if (q.has('terse')) {
    warnings.push(w('TERSE_MODEL', 'warn',
      'This model under-delivers; completeness clauses and the audit stage are mandatory',
      'The COMPLETENESS FLOOR block is injected into every stage and the audit stage is protected from auto-trimming.', null));
  }
  if (ft.trainsOnData) {
    warnings.push(w('TRAIN_ON_DATA', 'warn',
      'This free tier may use prompts for model training',
      'Your brief and generated code can leave your machine. Never put a secret or client-confidential data in a brief for this model.', null));
  }
  if (model.unverified) {
    warnings.push(w('UNVERIFIED_MODEL', 'warn',
      'Model not in the catalogue - limits inherited conservatively',
      `Assumed ${model.outputCeiling} output ceiling and ${model.contextWindow} context. Update server/lib/catalog.js with the real numbers to unlock bigger stages.`,
      fix('Add to catalogue', 'open-catalog')));
  }
  if (model.quality < 6.5 && sizeTokens > 9000) {
    warnings.push(w('WEAK_MODEL_SCOPE', 'warn',
      'Capability and scope disagree',
      `This model is a ~${model.quality}/10 coding model for a ${sizeTokens}-token build. Expect to re-run stages. A 70B-class free model usually needs fewer total requests even though each one is smaller.`,
      fix('Use a stronger free model', 'set-model', { modelId: 'gemini-2.5-flash' })));
  }

  return {
    fits: !warnings.some((x) => x.severity === 'block'),
    model: {
      id: model.id, label: model.label, provider: model.provider,
      outputCeiling: model.outputCeiling, contextWindow: model.contextWindow,
      quality: model.quality, speedTps: model.speedTps, family: model.family,
      unverified: !!model.unverified, verifiedAt: model.verifiedAt ?? null,
    },
    sizeTokens,
    perStageTokens: perStageFinal,
    parts,
    requestedParts: requestCount,
    totalRequests: totalRequests,
    projectedRequests: Math.round(projected),
    projectedTokens: Math.round(dayTokens * 1.6),
    ceilingUsable,
    ceilingUtilPct: Math.round(ceilingUtil * 100),
    contextPct: Math.round(contextPct),
    rpdPct: rpdPct == null ? null : round1(rpdPct),
    tpdPct: tpdPct == null ? null : round1(tpdPct),
    etaMinutes: Math.round(etaMinutes * 10) / 10,
    minSpacingSec,
    freeTier: ft,
    warnings,
  };
}

/**
 * A pack-level budget roll-up for the UI gauges.
 */
export function stageBudget({ model, inputTokens, expectedOutputTokens }) {
  const ceilingPct = (expectedOutputTokens / model.outputCeiling) * 100;
  const contextPct = ((inputTokens + expectedOutputTokens) / model.contextWindow) * 100;
  return {
    inputTokens,
    expectedOutputTokens,
    maxTokensParam: Math.min(model.outputCeiling, pad(expectedOutputTokens, 0.18)),
    ceilingPct: Math.round(ceilingPct),
    contextPct: Math.round(contextPct),
    overCeiling: expectedOutputTokens > model.outputCeiling * CEILING_SAFETY,
    seconds: model.speedTps ? Math.round(expectedOutputTokens / model.speedTps) : null,
  };
}

export function promptTokens(system, user, context) {
  return {
    system: estimateTokens(system, 'mixed'),
    user: estimateTokens(user, 'mixed'),
    context: context ? estimateTokens(context, 'mixed') : 0,
    input: estimateTokens(system, 'mixed') + estimateTokens(user, 'mixed') + estimateTokens(context || '', 'mixed'),
  };
}

const fmtN = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'K' : String(n));

function round1(n) {
  return n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
}

function w(code, severity, title, detail, ...fixes) {
  const out = { code, severity, title, detail };
  const actionable = fixes.filter(Boolean);
  if (actionable.length) out.fixes = actionable;
  return out;
}

function fix(label, action, params = {}) {
  return { label, action, params };
}

/** Highest published daily-request allowance in the catalogue, used in fixes. */
function highestRpdModelId() {
  return listModels()
    .filter((m) => m.freeTier?.rpd)
    .sort((a, b) => b.freeTier.rpd - a.freeTier.rpd)[0]
    ?.id ?? DEFAULT_MODEL_ID;
}
