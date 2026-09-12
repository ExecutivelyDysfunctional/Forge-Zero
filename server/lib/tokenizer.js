/**
 * Forge-Zero token estimation.
 *
 * Free-tier providers are gated by *token* budgets (TPM/TPD) and by hard
 * per-response output ceilings, so every prompt we compose has to be measured
 * before it ships. We cannot import a real BPE tokenizer without a dependency
 * and a ~2MB vocab file, so we use a calibrated heuristic and are explicit
 * about its error bars.
 *
 * Measured against typical ChatML-style tokenizers:
 *   - prose            ~4.0 characters / token
 *   - source code      ~3.3 characters / token (punctuation splits aggressively)
 *   - CJK + Kana       ~1.0 character  / token (sometimes worse)
 *
 * Reported error is +/-15%; every consumer of these numbers must treat
 * "fits" decisions as conservative, i.e. compare against a headroom-adjusted
 * ceiling rather than the raw ceiling.
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

const CHARS_PER_TOKEN = {
  prose: 4.0,
  code: 3.3,
  mixed: 3.6,
};

/**
 * Estimate tokens for a blob of text.
 * @param {string} text
 * @param {'prose'|'code'|'mixed'} [kind]
 * @returns {number}
 */
export function estimateTokens(text, kind = 'mixed') {
  if (!text) return 0;
  const s = String(text);
  const cjkMatches = s.match(CJK);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const rest = s.length - cjkChars;
  const perToken = CHARS_PER_TOKEN[kind] ?? CHARS_PER_TOKEN.mixed;
  return Math.ceil(cjkChars + rest / perToken);
}

/**
 * Estimate the tokens a model will emit for N lines of generated source.
 * Model-authored code averages ~44 characters and ~11 tokens per line.
 * @param {number} lines
 */
export function estimateOutputTokens(lines) {
  return Math.max(0, Math.round(lines * 11));
}

/** Convert an output-token estimate back to a line budget. */
export function tokensToLines(tokens) {
  return Math.max(0, Math.round(tokens / 11));
}

/**
 * Break a composed prompt down so the UI can explain where the budget went.
 * @param {{system?:string,user?:string,context?:string}} parts
 */
export function estimatePromptTokens({ system = '', user = '', context = '' }) {
  const systemTokens = estimateTokens(system, 'mixed');
  const userTokens = estimateTokens(user, 'mixed');
  const contextTokens = estimateTokens(context, 'mixed');
  return {
    system: systemTokens,
    user: userTokens,
    context: contextTokens,
    input: systemTokens + userTokens + contextTokens,
    total: systemTokens + userTokens + contextTokens,
  };
}

/**
 * Conservative planning number: pads an estimate so we do not schedule a stage
 * that only fits if the tokenizer undercounts.
 * @param {number} tokens
 * @param {number} [pct]
 */
export function pad(tokens, pct = 0.15) {
  return Math.ceil(tokens * (1 + pct));
}

export const TOKENIZER_NOTE =
  'Heuristic estimator (chars/token by content class), +/-15%. Never used for billing, only for fitting work inside free-tier ceilings.';
