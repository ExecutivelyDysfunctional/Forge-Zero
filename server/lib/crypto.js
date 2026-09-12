/**
 * Secrets at rest. Provider API keys are encrypted with AES-256-GCM before they
 * touch SQLite and are only ever returned to clients masked (last 4 chars). The
 * browser never learns a key; every request that needs one is proxied.
 */
import crypto from 'node:crypto';
import { resolveSecret } from '../config.js';

const ALGO = 'aes-256-gcm';

function keyMaterial() {
  return crypto.createHash('sha256').update(resolveSecret(), 'utf8').digest();
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyMaterial(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(row) {
  if (!row?.ciphertext) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, keyMaterial(), Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong FORGE_SECRET, or a row copied between installs. Never crash on it:
    // the caller reports "key unreadable, re-enter it", which is the truth.
    return null;
  }
}

export function maskKey(plaintext) {
  const s = String(plaintext ?? '');
  if (!s) return null;
  const tail = s.slice(-4);
  return `${s.slice(0, Math.min(3, s.length))}${'•'.repeat(Math.max(6, Math.min(18, s.length - 3)))}${tail}`;
}

export function fingerprint(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest('hex').slice(0, 12);
}

/** Shape of a provider key as it may be sent to a client. */
export function keyInfo(providerId, row, plaintext) {
  return {
    provider: providerId,
    configured: !!row && !!plaintext,
    readable: !!plaintext,
    masked: plaintext ? maskKey(plaintext) : row ? '(stored value could not be decrypted)' : null,
    fingerprint: plaintext ? fingerprint(plaintext) : null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
    source: row?.source ?? null,
  };
}
