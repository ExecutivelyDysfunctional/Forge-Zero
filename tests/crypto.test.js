import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, maskKey, fingerprint, keyInfo } from '../server/lib/crypto.js';

test('secrets round-trip and never appear in stored form', () => {
  const key = 'gsk_supersecretvalue_9876543210';
  const enc = encryptSecret(key);
  assert.notEqual(enc.ciphertext, key);
  assert.ok(!JSON.stringify(enc).includes(key));
  assert.equal(decryptSecret(enc), key);
});

test('a tampered or foreign ciphertext decrypts to null instead of throwing', () => {
  const enc = encryptSecret('hello-world-key');
  assert.equal(decryptSecret({ ...enc, ciphertext: Buffer.from('x'.repeat(24)).toString('base64') }), null);
  assert.equal(decryptSecret(null), null);
});

test('masking keeps enough to identify the key and nothing enough to use it', () => {
  const masked = maskKey('sk-proj-abcdefghijklmnop1234');
  assert.match(masked, /^sk-/);
  assert.match(masked, /1234$/);
  assert.ok(!masked.includes('abcdefghijklmnop'));
  assert.equal(maskKey(''), null);
});

test('fingerprints are stable per key and hide the key itself', () => {
  assert.equal(fingerprint('abc123456'), fingerprint('abc123456'));
  assert.notEqual(fingerprint('abc123456'), fingerprint('abc123457'));
  assert.equal(fingerprint('abc').length, 12);
});

test('keyInfo reports configured-ness without leaking material', () => {
  const enc = encryptSecret('top-secret-key-value');
  const plain = decryptSecret(enc);
  const info = keyInfo('groq', { created_at: 'now', updated_at: 'now', source: 'db' }, plain);
  assert.equal(info.configured, true);
  assert.equal(info.readable, true);
  assert.ok(!JSON.stringify(info).includes('secret-key'));
  const unreadable = keyInfo('groq', { created_at: 'now', source: 'db' }, null);
  assert.equal(unreadable.configured, false);
  assert.match(unreadable.masked, /could not be decrypted/);
});
