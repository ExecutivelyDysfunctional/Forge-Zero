/**
 * Live execution of a stage ("test-drive this prompt from the workbench").
 *
 * Constraints that shape this file:
 *  - API keys never travel to the browser: the request carries a provider id and
 *    the server attaches the key.
 *  - Every request goes through the rate governor, so a user cannot burn a daily
 *    quota with an over-eager retry loop, and a 429 becomes a wait instead of a
 *    dead stage.
 *  - Output is streamed (SSE) and then verified; verification decides whether the
 *    stage is accepted, needs a continuation, or must be re-run.
 *  - Nothing here is required to use the tool. The pack is the product; this is
 *    a convenience that degrades to a clear message when there is no egress.
 */
import { Router } from 'express';
import { streamChat } from '../lib/providers.js';
import { schedule, onGovernorEvent } from '../lib/governor.js';
import { verifyOutput } from '../lib/verify-output.js';
import { composePack } from '../lib/composer.js';
import { normalizeSpec } from '../lib/spec.js';
import { getModel } from '../lib/catalog.js';
import { packs, projects, keys as keyRepo, artifacts, runs as runsRepo } from '../repo/index.js';
import { config } from '../config.js';
import { REPAIR_PROTOCOL, CONTINUE_PROTOCOL } from '../lib/blueprint.js';
import { estimateTokens } from '../lib/tokenizer.js';
import { packRecord } from './packs.js';

export const generateRouter = Router();

generateRouter.use((req, res, next) => {
  if (!config.allowGenerate) {
    return res.status(403).json({ ok: false, error: 'Live generation is disabled on this server (FORGE_ALLOW_GENERATE=0). Compose a pack and export it instead.' });
  }
  next();
});

generateRouter.post('/generate', async (req, res) => {
  const body = req.body ?? {};
  const { packId, projectId, stageIndex, stageKey, mode = 'stage', context = '', stream = true, force = false } = body;

  let pack = body.pack ?? null;
  let savedPackId = packId ?? null;
  if (!pack && packId) pack = packs.get(packId)?.pack ?? null;
  if (!pack && body.spec) {
    const normalized = normalizeSpec({ ...(body.spec ?? {}), mode: body.mode ?? 'single-file' }, body.mode ?? 'single-file');
    if (!normalized.ok) return res.status(422).json({ ok: false, errors: normalized.errors });
    pack = composePack({ mode: normalized.spec.mode, spec: normalized.spec, modelId: body.modelId, options: body.options ?? {} });
    if (projectId) {
      const p = projects.get(projectId);
      if (p) savedPackId = packs.save(packRecord(p.id, pack));
    }
  }
  if (!pack) return res.status(400).json({ ok: false, error: 'Provide packId, projectId+spec, or an inline pack.' });

  const stage = pack.stages.find((s) => (stageKey ? s.id === stageKey : Number(s.index) === Number(stageIndex ?? 0)));
  if (!stage) return res.status(400).json({ ok: false, error: 'Unknown stage' });

  const model = getModel(pack.model.id, { provider: pack.model.provider });
  const { plaintext: apiKey } = keyRepo.get(model.provider);
  if (!apiKey && model.provider !== 'ollama') {
    return res.status(412).json({
      ok: false,
      error: `No API key stored for ${model.providerLabel}.`,
      hint: `Add one in the Keys panel (encrypted at rest) or fetch a free key at ${model.keyUrl}. The prompt pack itself is complete and copy-pasteable without any key.`,
      copyable: true,
    });
  }

  const priorManifest = savedPackId
    ? artifacts.forPack(savedPackId).map((a) => (a.files ?? []).map((f) => f).join(', ')).filter(Boolean)
    : [];
  const user = [
    substituteManifest(stage.user, priorManifest, context),
    mode === 'continue' ? ['', CONTINUE_PROTOCOL].join('\n') : '',
    mode === 'repair' ? ['', REPAIR_PROTOCOL, '', '<FAILURE>', String(body.failure ?? '').slice(0, 12000), '</FAILURE>'].join('\n') : '',
  ].join('\n');

  const isPlan = stage.kind === 'plan';
  const estTokens = stage.budget.inputTokens + stage.budget.expectedOutputTokens;
  const runId = savedPackId ? runsRepo.start({ packId: savedPackId, stageKey: stage.id, provider: model.provider, modelId: model.id }) : null;
  const started = Date.now();

  // SSE setup
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 15_000);
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  let text = '';
  let result = null;
  try {
    send('meta', { runId, stageId: stage.id, model: { id: model.id, label: model.label, provider: model.provider }, maxTokens: stage.budget.maxTokensParam, estTokens, governor: true });
    result = await schedule(model.provider, { rpm: model.freeTier?.rpm, tpm: model.freeTier?.tpm }, estTokens, async () =>
      streamChat({
        modelId: model.id,
        system: stage.system,
        user,
        params: { ...stage.params, max_tokens: stage.budget.maxTokensParam },
        apiKey,
        stream,
        isJsonPlan: isPlan,
        signal: ac.signal,
        timeoutMs: config.generateTimeoutMs,
        onDelta: (delta) => { text += delta; send('delta', { t: delta }); },
      })
    );
    const finalText = result.text ?? text;
    const verify = verifyOutput(finalText, {
      kind: isPlan ? 'plan' : 'code',
      expectedFiles: stage.files,
      expectedKeys: isPlan ? requiredKeysFor(pack.mode) : undefined,
      manifestSoFar: [...new Set(priorManifest.join(', ').split(',').map((s) => s.trim()).filter(Boolean))],
    });
    if (savedPackId) {
      artifacts.save({ packId: savedPackId, stageKey: stage.id, kind: isPlan ? 'plan' : 'code', text: verify.cleaned, files: verify.files.map((f) => f.path) });
    }
    if (runId) {
      runsRepo.finish(runId, {
        status: verify.ok ? 'ok' : 'verify-failed',
        inputTokens: result.usage?.input ?? estimateTokens(stage.system + user),
        outputTokens: result.usage?.output ?? estimateTokens(finalText, 'code'),
        ms: Date.now() - started,
        attempts: result.attempt ?? 1,
        verify: { ok: verify.ok, needsContinuation: verify.needsContinuation, issues: verify.issues.map((i) => i.code) },
      });
    }
    send('done', {
      ok: verify.ok,
      needsContinuation: verify.needsContinuation,
      chars: finalText.length,
      lines: verify.stats.lines,
      ms: Date.now() - started,
      usage: result.usage,
      finishReason: result.finishReason,
      attempts: result.attempt ?? 1,
      waitedMs: result.waitedMs ?? 0,
      issues: verify.issues,
      files: verify.files,
      artifact: savedPackId ? { packId: savedPackId, stageId: stage.id } : null,
      force,
    });
  } catch (err) {
    const payload = {
      ok: false,
      error: err?.message ?? String(err),
      kind: err?.kind ?? 'unknown',
      status: err?.status ?? 0,
      attempt: err?.attempt ?? 1,
      partial: text.length > 0 ? { chars: text.length, tail: tail(text, 400) } : null,
      recovery: recoveryFor(err, model),
    };
    if (runId) runsRepo.finish(runId, { status: err?.kind === 'cancelled' ? 'cancelled' : 'error', ms: Date.now() - started, error: payload.error.slice(0, 500) });
    send('error', payload);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

function recoveryFor(err, model) {
  switch (err?.kind) {
    case 'rate-limit':
      return `Your ${model.providerLabel} free tier is saturated right now. The governor already backed off; wait a minute and re-run only this stage - earlier stages are stored and do not need redoing.`;
    case 'network':
      return 'No egress to the provider from this server. Nothing is lost: copy the stage prompt and run it locally, or deploy Forge-Zero somewhere that can reach the API.';
    case 'timeout':
      return `The model did not finish inside ${Math.round(config.generateTimeoutMs / 1000)}s. Re-run with a smaller stage (raise the part count) or a faster endpoint such as Groq or Cerebras.`;
    case 'auth':
      return `Check the key for ${model.providerLabel}: it must be active and entitled to "${model.id}" on the free tier.`;
    case 'bad-request':
      return `The provider rejected the payload. Most often max_tokens (${model.outputCeiling} assumed here) is above what this model allows - correct it in the catalogue and re-compose.`;
    default:
      return null;
  }
}

function substituteManifest(userText, priorManifest, context) {
  const manifestLine = priorManifest.length ? priorManifest.join('\n') : '(no prior stages recorded — nothing exists yet)';
  let out = String(userText).replaceAll('{{PRIOR_MANIFEST}}', manifestLine);
  if (context && String(context).trim()) {
    out += '\n\n<PROVIDED_CONTEXT>\n' + String(context).slice(0, 60_000) + '\n</PROVIDED_CONTEXT>\n';
  }
  return out;
}

function requiredKeysFor(mode) {
  return mode === 'full-stack'
    ? ['stack', 'files', 'entities', 'api', 'clientRoutes', 'env', 'stagePlan', 'risks']
    : ['name', 'views', 'state', 'actions', 'storage', 'seed', 'acceptance'];
}

function tail(text, n) {
  const s = String(text);
  return s.length <= n ? s : '…' + s.slice(-n);
}

/** Stream the governor/queue state so the UI can show why a stage is waiting. */
generateRouter.get('/governor/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const off = onGovernorEvent((evt) => res.write(`event: governor\ndata: ${JSON.stringify(evt)}\n\n`));
  req.on('close', off);
});
