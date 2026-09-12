import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOutput } from '../server/lib/verify-output.js';

const GOOD = [
  '// FILE: index.html',
  '<!DOCTYPE html><html><head><style>.a { color: red; }</style></head><body>',
  '<main id="app"><button data-action="go">Go</button></main>',
  '<script>\', \'use strict\';',
  'const CONFIG = { key: "app.v1" };',
  'function boot() { document.getElementById("app"); }',
  'boot();',
  '</script></body></html>',
  '// @MANIFEST',
  'index.html :: boot :: 9',
].join('\n').replace("'use strict';", "'use strict';");

test('a clean, protocol-correct reply is accepted', () => {
  const r = verifyOutput(GOOD);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.needsContinuation, false);
  assert.deepEqual(r.files.map((f) => f.path), ['index.html']);
});

test('silent truncation is detected and reported as resumable, not fatal', () => {
  const r = verifyOutput('// FILE: index.html\nfunction a() {\n  const x = 1;\n');
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'unbalanced'));
  assert.equal(r.needsContinuation, true, 'a half-file should trigger a CONTINUE, not a stage rewrite');
});

test('an explicit CONTINUE marker is honoured', () => {
  const r = verifyOutput('// FILE: index.html PART:1 OF:2\nconst a = {x:1};\n// <<CONTINUE index.html next:2>>\n// @MANIFEST\nindex.html :: a :: 2');
  assert.ok(r.issues.some((i) => i.code === 'partial'));
  assert.equal(r.continuationTarget, 'index.html');
});

test('stub language, missing headers and diff noise all fail the stage', () => {
  assert.ok(verifyOutput('// FILE: a.js\nconst x = 1; // TODO implement').issues.some((i) => i.code === 'todo'));
  assert.ok(verifyOutput('<html></html>').issues.some((i) => i.code === 'no-file-header'));
  assert.ok(verifyOutput('// FILE: a.js\n--- a.js\n+++ a.js\nconst x = 1;').issues.some((i) => i.code === 'diff-noise'));
  assert.ok(verifyOutput('// FILE: a.js\n// ...rest of the code remains unchanged').issues.some((i) => i.code === 'stub'));
});

test('an empty reply is a hard failure with an actionable message', () => {
  const r = verifyOutput('   ');
  assert.equal(r.ok, false);
  assert.match(r.issues[0].message, /temperature 0/);
});

test('leaked credentials are caught before they reach a file', () => {
  for (const secret of ['const k = "sk-abcdefghij1234567890";', 'AWS_KEY = "AKIAABCDEFGHIJKLMNOP"', 'const p = "AIzaSyabcdefghijklmnopqrstuvwxyz12345";']) {
    const r = verifyOutput(`// FILE: config.js\n${secret}\n// @MANIFEST\nconfig.js :: none :: 2`);
    assert.ok(r.issues.some((i) => i.code === 'secret'), secret);
  }
});

test('the plan stage is parsed as JSON and its keys are checked', () => {
  const good = '{"name":"x","views":[],"state":{},"actions":[],"storage":{},"seed":[],"acceptance":[]}';
  assert.equal(verifyOutput(good, { kind: 'plan', expectedKeys: ['name', 'views', 'state'] }).ok, true);
  const bad = '{"name":"x", "views":[],}';
  const r = verifyOutput('Sure! Here you go:\n' + bad, { kind: 'plan' });
  assert.equal(r.ok, false);
  assert.match(r.issues[0].message, /Trailing comma/);
});

test('re-emitting an earlier file without @REPLACE is a warning, not a failure', () => {
  const r = verifyOutput('// FILE: server/db.js\nexport const a = 1;\n// @MANIFEST\nserver/db.js :: a :: 2', { manifestSoFar: ['server/db.js'] });
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.code === 'restated'));
});

test('promised files that never arrived are listed', () => {
  const r = verifyOutput('// FILE: a.js\nexport const a = 1;\n// @MANIFEST\na.js :: a :: 2', { expectedFiles: ['a.js', 'b.js'] });
  assert.ok(r.issues.some((i) => i.code === 'missing-files' && i.message.includes('b.js')));
});

test('fences are stripped and chatty preamble is dropped for storage', () => {
  const raw = 'Sure! Here is the file:\n```js\n// FILE: a.js\nexport const a = 1;\n// @MANIFEST\na.js :: a :: 2\n```';
  const r = verifyOutput(raw);
  assert.ok(r.issues.some((i) => i.code === 'fenced'));
  assert.match(r.cleaned, /^\/\/ FILE: a\.js/);
  assert.ok(!r.cleaned.includes('```'));
});

test('string and comment contents do not corrupt the brace balance check', () => {
  const tricky = ['// FILE: a.js', 'const s = "}";', 'const t = `${"}"`;', '/* } */', 'export const x = { a: 1 };', '// @MANIFEST', 'a.js :: x :: 5'].join('\n');
  assert.equal(verifyOutput(tricky).ok, true, JSON.stringify(verifyOutput(tricky).issues));
});
