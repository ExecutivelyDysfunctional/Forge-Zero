/**
 * Postflight verification of a model reply.
 *
 * This is the reason the output protocol is mechanical: every check below is a
 * cheap regex or a balance scan, and together they catch the failures that
 * actually stop a free-model build - silent truncation, "for brevity" stubs,
 * invented file lists, and a pasted secret. Run before a stage is accepted, so a
 * broken reply is retried immediately instead of poisoning the next five stages.
 */

const BANNED = [
  { re: /\bTODO\b|\bFIXME\b|\bXXX\b/, code: 'todo', message: 'A TODO/FIXME survived into the artifact' },
  { re: /\/\/\s*\.\.\.|^\s*\.\.\.\s*$|\{\s*\.\.\.\s*\}(?!\s*[):,])/m, code: 'elision', message: 'An ellipsis stands in for code' },
  { re: /\bfor brevity\b|\brest of (the )?(code|file)s? (remains|unchanged)\b|\bsame as before\b|\bimplement (your|the) (own|logic) here\b/i, code: 'stub', message: 'Model substituted an explanation for an implementation' },
  { re: /^\s*(---|\+\+\+) /m, code: 'diff-noise', message: 'Diff markers found; the reply is a patch, not a file' },
];

const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, label: 'OpenAI-style key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: 'GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: 'Slack token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key block' },
  { re: /AIza[0-9A-Za-z_-]{30,}/, label: 'Google API key' },
  { re: /\b(password|passwd|secret|api[_-]?key)\b\s*[:=]\s*['"][^'"]{8,}['"]/i, label: 'hardcoded credential literal' },
];

const FILE_HEADER = /^(?:\/\/|#|<!--|\/\*)\s*FILE:\s*([^\s*]+)(.*?)$/;
const CONTINUE_RE = /<<CONTINUE\s+([^\s>]+)\s+next:(\d+)>>/;
const BLOCKED_RE = /@BLOCKED\s+(.+)/;

/**
 * @param {string} text  raw model reply
 * @param {object} [opts]
 * @param {'code'|'plan'|'audit'} [opts.kind]
 * @param {string[]} [opts.expectedFiles]
 * @param {string[]} [opts.manifestSoFar]
 */
export function verifyOutput(text, opts = {}) {
  const raw = String(text ?? '');
  // The fence check has to look at what the model actually sent, before the
  // cleaner removes it - otherwise the most common protocol violation is
  // silently fixed and nobody learns to ban it for this model.
  const fenced = /```/.test(raw);
  const body = stripFences(raw);
  const issues = [];
  const files = [];

  if (!body.trim()) {
    return { ok: false, needsContinuation: false, files, issues: [issue('empty', 'block', 'Empty reply', 'The model returned nothing. Retry once at temperature 0 before touching the prompt.')] };
  }

  for (const line of body.split('\n')) {
    const m = FILE_HEADER.exec(line.trim());
    if (m) files.push({ path: m[1], flags: (m[2] ?? '').trim(), line: line.trim() });
  }

  const isPlan = opts.kind === 'plan';
  if (isPlan) {
    const parsed = parseLooseJson(body);
    if (!parsed.ok) {
      issues.push(issue('json-invalid', 'block', 'Plan stage is not parseable JSON', parsed.error));
    } else {
      const required = opts.expectedKeys ?? [];
      const missing = required.filter((k) => !(k in parsed.value));
      if (missing.length) issues.push(issue('json-missing-keys', 'warn', 'Plan JSON is missing keys', missing.join(', ')));
    }
  } else if (!files.length) {
    issues.push(issue('no-file-header', 'block', 'No `// FILE:` header found',
      'Without a header the build script cannot know where the artifact starts. This is the protocol violation that forces a re-run most often.'));
  }

  if (fenced && !isPlan) {
    issues.push(issue('fenced', 'warn', 'Reply is wrapped in code fences',
      'The fences are stripped by the workbench, but a fence nested inside the file would corrupt it. Check the reassembled file compiles.'));
  }

  // Banned content
  for (const { re, code, message } of BANNED) {
    if (re.test(body)) issues.push(issue(code, 'block', 'Stub language in output', message));
  }

  // Secrets
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(body)) issues.push(issue('secret', 'block', `Credential-like string detected (${label})`,
      'Generated code must read secrets from the environment. Remove the literal and re-run the stage; if this came from your brief, remove it there too.'));
  }

  // Structural balance (heuristic but high signal for truncation)
  const balance = braceBalance(body);
  if (!isPlan && !balance.balanced) {
    issues.push(issue('unbalanced', 'block', `Unbalanced ${balance.which}`,
      `Counts differ by ${balance.delta}. Almost always means the reply stopped mid-file - send a continuation rather than accepting this output.`));
  }

  // Truncation / continuation
  const cont = CONTINUE_RE.exec(body);
  const blocked = BLOCKED_RE.exec(body);
  const endsAbruptly = !isPlan && !/(@MANIFEST|<<CONTINUE)/.test(body) && !/[}\]`"';)\s]$/.test(body.slice(-40));
  // Unbalanced brackets without a CONTINUE marker is the classic silent
  // truncation: the model simply ran out of ceiling. Treat it as resumable
  // rather than as a rewrite - re-running the stage loses everything above it.
  const needsContinuation = !isPlan && !blocked && (!!cont || endsAbruptly || !balance.balanced);

  if (blocked) issues.push(issue('blocked', 'block', 'Model declared itself blocked', blocked[1].trim()));
  if (cont) issues.push(issue('partial', 'info', `Part ${files.length ? files.map((f) => f.path).join(', ') : '(unknown file)'} continues`,
    `Send the continuation prompt for ${cont[1]} (next part ${cont[2]}).`));

  // Expected files
  if (opts.expectedFiles?.length && !isPlan) {
    const missing = opts.expectedFiles.filter((p) => !files.some((f) => f.path === p || f.path.endsWith(p)));
    if (missing.length) issues.push(issue('missing-files', 'warn', 'Some files the stage promised were not emitted', missing.join(', ')));
  }

  // Restating an earlier file that was not marked @REPLACE
  if (opts.manifestSoFar?.length) {
    const restated = files.filter((f) => opts.manifestSoFar.includes(f.path) && !/@REPLACE/.test(f.flags));
    if (restated.length) {
      issues.push(issue('restated', 'warn', 'Earlier files re-emitted without @REPLACE',
        `${restated.map((f) => f.path).join(', ')} were sent again. The workbench keeps the newest copy, so this is not fatal, but it burned output budget that the stage needed.`));
    }
  }

  return {
    ok: !issues.some((i) => i.severity === 'block'),
    needsContinuation,
    continuationTarget: cont?.[1] ?? (endsAbruptly ? files.at(-1)?.path ?? null : null),
    blocked: !!blocked,
    files,
    stats: { lines: body.split('\n').length, chars: body.length, fileCount: files.length },
    issues,
    cleaned: stripFences(cleanForPaste(body)),
  };
}

function stripFences(text) {
  return text
    .replace(/^\s*```[a-zA-Z0-9]*\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .replace(/^```[a-zA-Z0-9]*\s*$|^\s*```$/gm, '');
}

/** Drop chatty pre/postamble so a careless model still lands in the right file. */
function cleanForPaste(text) {
  const lines = text.split('\n');
  while (lines.length && !FILE_HEADER.test(lines[0].trim()) && !/^\{/.test(lines[0].trim())) lines.shift();
  return lines.join('\n');
}

function braceBalance(text) {
  // Strip comments and string contents first, or the count is meaningless.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
  const counts = { '{': 0, '}': 0, '(': 0, ')': 0, '[': 0, ']': 0 };
  for (const ch of stripped) if (ch in counts) counts[ch] += 1;
  const delta = counts['{'] - counts['}'];
  if (delta !== 0) return { balanced: false, which: 'braces', delta };
  const paren = counts['('] - counts[')'];
  if (paren !== 0) return { balanced: false, which: 'parentheses', delta: paren };
  const brack = counts['['] - counts[']'];
  if (brack !== 0) return { balanced: false, which: 'brackets', delta: brack };
  return { balanced: true, which: null, delta: 0 };
}

function parseLooseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'No JSON object found in the reply.' };
  const slice = text.slice(start, end + 1);
  try {
    return { ok: true, value: JSON.parse(slice) };
  } catch (err) {
    const trailing = /,\s*[}\]]/.test(slice);
    return {
      ok: false,
      error: trailing
        ? 'Trailing comma before a closing bracket - the most common failure when a model writes JSON by hand.'
        : err.message,
    };
  }
}

function issue(code, severity, title, message) {
  return { code, severity, title, message };
}
