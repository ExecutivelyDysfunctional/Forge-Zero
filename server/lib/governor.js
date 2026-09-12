/**
 * Free-tier rate governor.
 *
 * The difference between a tool that "supports free models" and one that is
 * actually built for them: every outbound request is scheduled so a user cannot
 * blow their daily quota by accident, and a 429 is handled by waiting instead of
 * by failing the stage. Limits come from the catalogue per provider; when a
 * provider publishes none, we still serialise.
 *
 * One queue per provider, concurrency 1 (a single key cannot parallelise usefully
 * at 6K TPM anyway), plus a rolling 60s window for requests and tokens.
 */

const state = new Map();
const listeners = new Set();

function bucketFor(providerId, limits = {}) {
  if (!state.has(providerId)) {
    state.set(providerId, {
      providerId,
      limits,
      requests: [],
      tokens: [],
      inflight: 0,
      queue: [],
      backoffUntil: 0,
      served: 0,
      rateLimited: 0,
    });
  } else {
    state.get(providerId).limits = { ...state.get(providerId).limits, ...limits };
  }
  return state.get(providerId);
}

const MIN_SPACING_MS = 250;

function pruneTimes(times, now) {
  const cutoff = now - 60_000;
  while (times.length && times[0] < cutoff) times.shift();
}

/** Token entries carry an amount, so they are pruned by their own timestamp. */
function pruneTokens(entries, now) {
  const cutoff = now - 60_000;
  while (entries.length && entries[0].at < cutoff) entries.shift();
}

async function waitForSlot(bucket, estTokens) {
  const waited = [];
  for (let guard = 0; guard < 500; guard++) {
    const now = Date.now();
    pruneTimes(bucket.requests, now);
    pruneTokens(bucket.tokens, now);
    const { rpm, tpm } = bucket.limits;
    const backoff = bucket.backoffUntil - now;
    const lastReq = bucket.requests.at(-1);
    const tooSoon = lastReq != null && now - lastReq < MIN_SPACING_MS;
    const rpmFull = rpm && bucket.requests.length >= Math.max(1, rpm - 1);
    const tokenLoad = bucket.tokens.reduce((a, b) => a + b, 0) + estTokens;
    const tpmFull = tpm && tokenLoad > tpm;
    if (backoff > 0) { waited.push({ reason: 'backoff', ms: backoff }); await sleep(Math.min(backoff, 5_000)); continue; }
    if (rpmFull) { const wait = 60_000 - (now - bucket.requests[0]) + 50; waited.push({ reason: 'rpm', ms: wait }); await sleep(Math.min(wait, 15_000)); continue; }
    if (tpmFull) { const wait = 1_500; waited.push({ reason: 'tpm', ms: wait }); await sleep(wait); continue; }
    if (tooSoon) { await sleep(MIN_SPACING_MS - (now - lastReq)); continue; }
    return { waitedMs: waited.reduce((a, b) => a + b.ms, 0), waits: waited };
  }
  return { waitedMs: 0, waits: [{ reason: 'governor-giveup', ms: 0 }] };
}

/**
 * Run `fn` when the provider's budget allows it, retrying 429s with backoff.
 * @param {string} providerId
 * @param {{rpm?:number,tpm?:number}} limits
 * @param {number} estTokens  expected request tokens (input + expected output)
 * @param {(attempt:number)=>Promise<any>} fn
 */
export async function schedule(providerId, limits, estTokens, fn) {
  const bucket = bucketFor(providerId, limits ?? {});
  const queued = bucket.queue.length;
  const ticket = {};
  bucket.queue.push(ticket);
  try {
    await drainTo(bucket, ticket);
    const { waitedMs, waits } = await waitForSlot(bucket, estTokens);
    const now = Date.now();
    bucket.requests.push(now);
    bucket.tokens.push({ at: now, n: estTokens });
    bucket.inflight++;
    emit({ type: 'start', providerId, queued, estTokens });
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const out = await fn(attempt);
        bucket.served++;
        emit({ type: 'done', providerId, attempt, waitedMs, waits });
        return { ...out, attempt, waitedMs, waits };
      } catch (err) {
        const isRate = err?.status === 429 || err?.kind === 'rate-limit';
        if (isRate && attempt <= 2) {
          bucket.rateLimited++;
          const waitMs = Math.min(90_000, (err.retryAfterSec ?? 20 * attempt) * 1000);
          bucket.backoffUntil = Date.now() + waitMs;
          emit({ type: 'backoff', providerId, waitMs, attempt });
          await sleep(Math.min(waitMs, 60_000));
          continue;
        }
        throw Object.assign(err, { attempt, waitedMs });
      } finally {
        bucket.inflight--;
      }
    }
  } finally {
    bucket.queue = bucket.queue.filter((t) => t !== ticket);
  }
}

async function drainTo(bucket, ticket) {
  while (bucket.queue[0] !== ticket || bucket.inflight > 0) {
    await sleep(150);
    if (bucket.queue.length === 0) return;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function onGovernorEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(evt) { for (const fn of listeners) { try { fn(evt); } catch { /* a bad listener must not stall a build */ } } }

export function governorSnapshot() {
  const now = Date.now();
  return [...state.values()].map((b) => ({
    provider: b.providerId,
    queued: b.queue.length,
    inflight: b.inflight,
    requestsLastMinute: (() => { pruneTimes(b.requests, now); return b.requests.length; })(),
    tokensLastMinute: (() => { pruneTokens(b.tokens, now); return b.tokens.reduce((a, x) => a + x.n, 0); })(),
    backoffMsLeft: Math.max(0, b.backoffUntil - now),
    served: b.served,
    rateLimited: b.rateLimited,
    limits: b.limits,
  }));
}
