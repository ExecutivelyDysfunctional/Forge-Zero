/**
 * Provider clients.
 *
 * One entry point, `streamChat`, that speaks each provider's dialect and
 * normalises everything back into {delta, done} events. Two things are
 * deliberate:
 *
 *  - **Keys are server-side only.** The browser sends a provider id, never a key.
 *    `fetch` here is the only place key material is attached.
 *  - **Errors are instructions, not stack traces.** On a free tier a 429 is not
 *    an exceptional event, it is Tuesday; the message says what to wait for.
 */

import { getModel, PROVIDERS } from './catalog.js';

export class ProviderError extends Error {
  constructor(message, { status = 0, kind = 'unknown', retryAfterSec = null, body = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.kind = kind;
    this.retryAfterSec = retryAfterSec;
    this.body = body;
  }
}

/** Provider-level defaults so unknown families fail loudly instead of quietly. */
export function endpointFor(modelId, { accountId } = {}) {
  const model = getModel(modelId);
  const base = model.baseUrl;
  switch (model.family) {
    case 'gemini':
      return { url: `${base}/models/${encodeURIComponent(model.id)}:generateContent`, streamUrl: `${base}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`, kind: 'gemini' };
    case 'cloudflare':
    case 'openai-compat': {
      const acct = accountId ?? process.env.CF_ACCOUNT_ID ?? '';
      if (model.provider === 'cloudflare' && !acct) {
        throw new ProviderError('Cloudflare needs CF_ACCOUNT_ID (dashboard → account id) before it can be called.', { kind: 'config' });
      }
      const root = model.provider === 'cloudflare' ? `${base}/${acct}/ai/v1` : base;
      return { url: `${root}/chat/completions`, streamUrl: `${root}/chat/completions`, kind: 'openai' };
    }
    default:
      return { url: `${base}/chat/completions`, streamUrl: `${base}/chat/completions`, kind: 'openai' };
  }
}

function authHeaders(model, apiKey) {
  if (model.family === 'gemini') return { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
  if (model.authHeader === 'none' || model.provider === 'ollama') return { 'content-type': 'application/json' };
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
}

function buildBody({ model, system, user, params, wantStream, isJsonPlan }) {
  const common = {
    temperature: params.temperature,
    ...(params.top_p != null ? { top_p: params.top_p } : {}),
  };
  if (model.family === 'gemini') {
    return {
      contents: [{ role: 'user', parts: [{ text: [system, '', user].join('\n') }] }],
      systemInstruction: { role: 'system', parts: [{ text: system }] },
      generationConfig: {
        ...common,
        maxOutputTokens: params.max_tokens,
        ...(isJsonPlan && model.supports?.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
      safetySettings: undefined,
      ...(wantStream ? {} : {}),
    };
  }
  return {
    model: model.id,
    messages: [
      ...(model.supports?.systemRole === false ? [{ role: 'user', content: `[SYSTEM]\n${system}` }] : [{ role: 'system', content: system }, { role: 'user', content: user }]),
    ],
    max_tokens: params.max_tokens,
    ...common,
    stream: wantStream,
    ...(isJsonPlan && model.supports?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(model.provider === 'ollama' ? { think: false } : {}),
  };
}

/**
 * Stream a stage. `onDelta(text)` receives text fragments as they arrive.
 * @returns {Promise<{text:string, usage:object|null, finishReason:string|null, ms:number}>}
 */
export async function streamChat({
  modelId, system, user, params, apiKey, stream = true, signal, onDelta, isJsonPlan = false, timeoutMs = 180_000, accountId,
}) {
  const model = getModel(modelId);
  if (!apiKey && model.provider !== 'ollama') {
    throw new ProviderError(
      `No API key configured for ${model.providerLabel}. Add one under Keys (stored encrypted, server-side) or export ${String(model.provider).toUpperCase()}_API_KEY.`,
      { kind: 'no-key' }
    );
  }
  const ep = endpointFor(model.id, { accountId });
  const url = stream ? ep.streamUrl : ep.url;
  const body = buildBody({ model, system, user, params, wantStream: stream, isJsonPlan });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(new Error('client-disconnect')), { once: true });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(model, apiKey ?? ''),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (String(err?.name) === 'AbortError' && signal?.aborted) throw new ProviderError('Cancelled by client.', { kind: 'cancelled' });
    if (String(err?.name) === 'AbortError') throw new ProviderError(`Provider did not respond within ${Math.round(timeoutMs / 1000)}s.`, { kind: 'timeout' });
    throw new ProviderError(
      `Could not reach ${model.providerLabel} (${err?.cause?.code ?? err?.message}). This box may have no egress to that host, or the endpoint is down - the prompt pack itself needs no network and is still valid.`,
      { kind: 'network' }
    );
  }

  try {
    if (!res.ok) throw await httpError(res, model);

    if (!stream) {
      const json = await res.json();
      const text = extractNonStream(json, ep.kind);
      onDelta?.(text);
      return { text, usage: normalizeUsage(json?.usage), finishReason: json?.choices?.[0]?.finish_reason ?? json?.candidates?.[0]?.finishReason ?? null, ms: Date.now() - started };
    }

    let text = '';
    let finishReason = null;
    let usage = null;
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const evt = parseSseLine(line, ep.kind);
        if (!evt) continue;
        if (evt.delta) { text += evt.delta; onDelta?.(evt.delta); }
        if (evt.finish) finishReason = evt.finish;
        if (evt.usage) usage = normalizeUsage(evt.usage);
      }
    }
    return { text, usage, finishReason, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function httpError(res, model) {
  let raw = '';
  try { raw = await res.text(); } catch { /* body already consumed by a broken proxy */ }
  let message = raw.slice(0, 600);
  try {
    const parsed = JSON.parse(raw);
    message = parsed?.error?.message ?? parsed?.error?.[0]?.message ?? parsed?.message ?? message;
  } catch { /* providers do not all answer JSON on errors */ }
  if (res.status === 429) {
    const ra = Number.parseFloat(res.headers.get('retry-after') ?? '');
    return new ProviderError(
      `Rate limited by ${model.providerLabel} (429). ${Number.isFinite(ra) ? `Retry in ~${Math.ceil(ra)}s.` : 'Free-tier windows reset per minute; back off and re-run only the failed stage.'}`,
      { status: 429, kind: 'rate-limit', retryAfterSec: Number.isFinite(ra) ? Math.ceil(ra) : null, body: raw.slice(0, 2000) }
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`${model.providerLabel} rejected the key (${res.status}). Check it is active, that the model id is right, and that the free tier is enabled on this project.`, { status: res.status, kind: 'auth', body: raw.slice(0, 2000) });
  }
  if (res.status === 400) {
    return new ProviderError(`${model.providerLabel} refused the request (400): ${message}. Usually max_tokens above the model ceiling, or an unknown model id.`, { status: 400, kind: 'bad-request', body: raw.slice(0, 2000) });
  }
  return new ProviderError(`${model.providerLabel} returned ${res.status}: ${message}`, { status: res.status, kind: 'http', body: raw.slice(0, 2000) });
}

function parseSseLine(line, kind) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('event:') || trimmed.startsWith('id:') || trimmed.startsWith(': ping')) return null;
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return { finish: 'stop' };
  let json;
  try { json = JSON.parse(payload); } catch { return null; }
  if (json?.error) throw new ProviderError(typeof json.error === 'string' ? json.error : json.error.message ?? 'stream error', { kind: 'stream' });
  if (kind === 'gemini') {
    const cand = json?.candidates?.[0];
    const delta = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    return { delta, finish: cand?.finishReason ?? null, usage: json?.usageMetadata };
  }
  const choice = json?.choices?.[0];
  const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
  const reasoning = choice?.delta?.reasoning_content ?? '';
  return { delta: typeof delta === 'string' ? delta : '', reasoning, finish: choice?.finish_reason ?? null, usage: json?.usage };
}

function extractNonStream(json, kind) {
  if (kind === 'gemini') return (json?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  return json?.choices?.[0]?.message?.content ?? '';
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    input: u.prompt_tokens ?? u.promptTokenCount ?? u.input_tokens ?? u.prompt_tokens_count ?? null,
    output: u.completion_tokens ?? u.candidatesTokenCount ?? u.output_tokens ?? null,
    total: u.total_tokens ?? u.totalTokenCount ?? null,
  };
}

/** Cheap key/endpoint validation used by the Keys panel. */
export async function testConnection(modelId, apiKey, { timeoutMs = 20_000 } = {}) {
  const model = getModel(modelId);
  const t0 = Date.now();
  try {
    const res = await fetch(endpointFor(model.id).url.replace('/chat/completions', '/models').replace(/:generateContent$/, '/models?key=' + encodeURIComponent(apiKey ?? '')), {
      headers: model.family === 'gemini' ? {} : authHeaders(model, apiKey ?? ''),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      let count = null;
      try { const j = await res.json(); count = Array.isArray(j?.data) ? j.data.length : Array.isArray(j?.models) ? j.models.length : null; } catch { /* some list endpoints return html */ }
      return { ok: true, status: res.status, ms: Date.now() - t0, models: count, message: count != null ? `Reachable; ${count} models listed on this key.` : 'Reachable.' };
    }
    const body = (await res.text()).slice(0, 300);
    return { ok: false, status: res.status, ms: Date.now() - t0, message: `Rejected (${res.status}): ${body}` };
  } catch (err) {
    return {
      ok: false, status: 0, ms: Date.now() - t0,
      message: `Unreachable from this server: ${err?.cause?.code ?? err?.message}. If this box has no egress, use the exported prompt pack or run the app where the provider is reachable.`,
    };
  }
}

export function providerSummary() {
  return PROVIDERS.map((p) => ({
    id: p.id, label: p.label, family: p.family, baseUrl: p.baseUrl, keyUrl: p.keyUrl,
    docsUrl: p.docsUrl, authHeader: p.authHeader, tierNote: p.tierNote,
    envVarNames: [`FORGE_${p.id.toUpperCase()}_API_KEY`, `${p.id.toUpperCase()}_API_KEY`],
    needsKey: p.id !== 'ollama',
  }));
}
