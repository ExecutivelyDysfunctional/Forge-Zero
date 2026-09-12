import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { packToMarkdown, packToCurl, bundleForDownload, packToStageFiles } from '../server/lib/formats.js';
import { composePack } from '../server/lib/composer.js';
import { normalizeSpec, PRESETS } from '../server/lib/spec.js';

const pack = (() => {
  const p = PRESETS.find((x) => x.id === 'team-status');
  const spec = normalizeSpec({ ...p.spec, mode: 'full-stack' }, 'full-stack').spec;
  return composePack({ mode: 'full-stack', spec, modelId: 'llama-3.3-70b-versatile', options: { strategy: 'staged' } });
})();

test('markdown export is a self-contained runbook', () => {
  const md = packToMarkdown(pack);
  assert.ok(md.length > 4000);
  assert.ok(md.startsWith(`# ${pack.spec.name} — Forge-Zero prompt pack`));
  assert.match(md, /\| Daily request use \|/);
  for (const [i, st] of pack.stages.entries()) {
    assert.ok(md.includes(`## Stage ${i + 1} — ${st.title}`), `missing stage ${i + 1}`);
  }
  assert.match(md, /verified/);
  assert.ok(!/undefined|\[object Object\]/.test(md.replace(/undefined identifiers/g, '')));
});

test('every markdown fence is balanced so the export can be pasted anywhere', () => {
  const md = packToMarkdown(pack);
  const fences = (md.match(/^```/gm) ?? []).length;
  assert.equal(fences % 2, 0, 'unbalanced code fences');
});

test('the curl runner is valid shell, keys stay in the environment', () => {
  const sh = packToCurl(pack);
  execFileSync('bash', ['-n'], { input: sh });
  assert.match(sh, /FORGE_API_KEY:\?set FORGE_API_KEY/);
  assert.match(sh, /SPACING=\d+ +# seconds, from the free-tier RPM limit/);
  assert.ok(!/api[_-]?key\s*=\s*["'][A-Za-z0-9-_]{12,}/.test(sh), 'no key material may be baked in');
  const opens = (sh.match(/<<'PROMPT_EOF'/g) ?? []).length;
  const closes = (sh.match(/^PROMPT_EOF$/gm) ?? []).length;
  assert.equal(opens, pack.stages.length, 'one heredoc per stage');
  assert.equal(opens, closes, 'each stage prompt needs an open and a close marker');
  assert.ok(sh.includes('run_stage 1'));
});

test('a heredoc line inside the prompt cannot terminate the block early', () => {
  const weird = { ...pack, stages: [{ ...pack.stages[0], user: 'first\nPROMPT_EOF\nlast' }] };
  const sh = packToCurl(weird);
  execFileSync('bash', ['-n'], { input: sh });
  assert.match(sh, /PROMPT_E'''OF/);
});

test('stage files and bundle are named for a folder, not a mess', () => {
  const files = packToStageFiles(pack);
  assert.equal(files.length, pack.stages.length);
  for (const f of files) {
    assert.match(f.name, /^\d{2}-[a-z0-9:._-]+\.txt$/);
    assert.match(f.contents, /=== SYSTEM ===/);
  }
  const bundle = bundleForDownload(pack);
  assert.deepEqual(Object.keys(bundle).filter((k) => k.startsWith('stages/')).length, pack.stages.length);
  for (const [name, body] of Object.entries(bundle)) {
    assert.ok(body.length > 20, `${name} is empty`);
    assert.ok(!name.includes('..'));
  }
});

test('json export round-trips a usable pack', () => {
  const bundle = bundleForDownload(pack);
  const parsed = JSON.parse(bundle['prompt-pack.json']);
  assert.equal(parsed.mode, 'full-stack');
  assert.equal(parsed.stages.length, pack.stageCount);
  assert.ok(parsed.stages[0].system.length > 800);
});
