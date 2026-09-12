/**
 * API client. Relative URLs only, so the app works behind any proxy or port, and
 * one SSE reader shared by every streamed call.
 */

async function request(method, path, body, opts = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { ok: false, error: `Non-JSON response (${res.status})`, raw: text.slice(0, 400) }; }
  if (!res.ok) {
    const err = new Error(json?.error ?? json?.message ?? `${res.status} ${res.statusText}`);
    err.payload = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b, o) => request('POST', p, b ?? {}, o),
  put: (p, b) => request('PUT', p, b ?? {}),
  del: (p) => request('DELETE', p, null),
  bootstrap: () => request('GET', '/api/bootstrap'),
  health: () => request('GET', '/api/health'),
  compose: (payload) => request('POST', '/api/packs/compose', payload),
  pack: (id) => request('GET', `/api/packs/${id}`),
  verify: (id, payload) => request('POST', `/api/packs/${id}/verify`, payload),
  assemble: (id) => request('POST', `/api/packs/${id}/assemble`, {}),
  repair: (payload) => request('POST', '/api/packs/repair', payload),
  continuePrompt: (payload) => request('POST', '/api/packs/continue', payload),
  recommend: (payload) => request('POST', '/api/models/recommend', payload),
  keys: () => request('GET', '/api/keys'),
  saveKey: (provider, key) => request('PUT', `/api/keys/${provider}`, { key }),
  deleteKey: (provider) => request('DELETE', `/api/keys/${provider}`),
  testKey: (provider, modelId) => request('POST', `/api/keys/${provider}/test`, { modelId }),
  projects: () => request('GET', '/api/projects'),
  createProject: (payload) => request('POST', '/api/projects', payload),
  updateProject: (id, payload) => request('PUT', `/api/projects/${id}`, payload),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),
  packProject: (id, payload) => request('POST', `/api/projects/${id}/packs`, payload ?? {}),
  runs: () => request('GET', '/api/runs'),
  saveState: (s) => request('PUT', '/api/packs/state/workbench', s),
  loadState: () => request('GET', '/api/packs/state/workbench'),
  exportPack: (id, format) => request('GET', `/api/packs/${id}/export?format=${format}`),
};

/**
 * POST + read Server-Sent-Events. Returns the parsed terminal event so callers do
 * not have to track stream state themselves.
 */
export async function stream(path, payload, handlers = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: handlers.signal,
  });
  if (!res.ok || !res.body) {
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON error body */ }
    throw new Error(json?.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let terminal = null;
  const dispatch = (event, data) => {
    if (event === 'delta') handlers.onDelta?.(data.t ?? '');
    else if (event === 'meta') handlers.onMeta?.(data);
    else if (event === 'error') { terminal = { type: 'error', data }; handlers.onError?.(data); }
    else if (event === 'done') { terminal = { type: 'done', data }; handlers.onDone?.(data); }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) { try { data = JSON.parse(line.slice(5).trim()); } catch { data = { raw: line.slice(5) }; } }
      }
      if (data != null) dispatch(event, data);
    }
  }
  if (!terminal) terminal = { type: 'closed', data: { note: 'stream ended without a terminal event' } };
  return terminal;
}
