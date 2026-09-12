/**
 * Runtime configuration. Everything is env-driven with safe defaults, because
 * Forge-Zero is meant to be cloneable and runnable in one command - and because
 * it stores API keys, so the secret-handling default matters.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.FORGE_HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? process.env.FORGE_PORT ?? '3000', 10),
  dataDir: resolve(ROOT, process.env.FORGE_DATA_DIR ?? 'data'),
  get dbPath() { return join(this.dataDir, 'forge-zero.db'); },
  secret: null,
  secretSource: null,
  allowGenerate: process.env.FORGE_ALLOW_GENERATE !== '0',
  generateTimeoutMs: Number.parseInt(process.env.FORGE_GENERATE_TIMEOUT_MS ?? '180000', 10),
  maxBriefChars: Number.parseInt(process.env.FORGE_MAX_BRIEF_CHARS ?? '40000', 10),
  rateLimit: { windowMs: 60_000, max: Number.parseInt(process.env.FORGE_HTTP_RATE ?? '120', 10) },
  version: readVersion(),
};

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

/**
 * Key-encryption secret. If FORGE_SECRET is unset we create a random one and
 * persist it 0600 next to the database, so a stored key is not readable by
 * whoever reads a backup of the .db file - without asking a first-time user to
 * configure crypto they do not care about yet.
 */
export function resolveSecret() {
  if (config.secret) return config.secret;
  const fromEnv = process.env.FORGE_SECRET?.trim();
  const secretFile = join(config.dataDir, '.forge-secret');
  if (fromEnv) {
    config.secret = fromEnv;
    config.secretSource = 'env';
    return fromEnv;
  }
  if (existsSync(secretFile)) {
    config.secret = readFileSync(secretFile, 'utf8').trim();
    config.secretSource = 'file';
    return config.secret;
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  writeFileSync(secretFile, generated + '\n', { mode: 0o600 });
  config.secret = generated;
  config.secretSource = 'generated';
  return generated;
}
