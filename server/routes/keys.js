/**
 * API key management. Plaintext keys enter this server and never leave it:
 * responses carry a mask and a hash fingerprint only. A provider whose key came
 * from the environment is reported as such and cannot be deleted through the UI,
 * because that would be a confusing no-op.
 */
import { Router } from 'express';
import { PROVIDERS } from '../lib/catalog.js';
import { keys as keyRepo } from '../repo/index.js';
import { testConnection } from '../lib/providers.js';
import { config } from '../config.js';

export const keyRouter = Router();

const validProvider = (id) => PROVIDERS.some((p) => p.id === id);

keyRouter.get('/', (_req, res) => {
  const ids = PROVIDERS.map((p) => p.id);
  const rows = keyRepo.list(ids);
  res.json({
    ok: true,
    keys: rows.map((r) => ({ ...r, envVarNames: [`FORGE_${r.provider.toUpperCase()}_API_KEY`, `${r.provider.toUpperCase()}_API_KEY`] })),
    encrypted: true,
    secretSource: config.secretSource,
  });
});

keyRouter.put('/:provider', (req, res) => {
  const { provider } = req.params;
  if (!validProvider(provider)) return res.status(400).json({ ok: false, error: `Unknown provider "${provider}"` });
  const raw = String(req.body?.key ?? '');
  if (raw.length < 8) return res.status(422).json({ ok: false, error: 'That does not look like an API key.' });
  if (raw.length > 4096) return res.status(422).json({ ok: false, error: 'API key too long; paste just the key.' });
  const { row } = keyRepo.set(provider, raw.trim());
  res.json({ ok: true, stored: !!row, note: 'Encrypted with AES-256-GCM before it touches SQLite.' });
});

keyRouter.delete('/:provider', (req, res) => {
  const removed = keyRepo.remove(req.params.provider);
  res.json({ ok: true, removed, note: removed ? null : 'No stored key for that provider (an environment key is still in use).' });
});

keyRouter.post('/:provider/test', async (req, res) => {
  const { provider } = req.params;
  if (!validProvider(provider)) return res.status(400).json({ ok: false, error: 'Unknown provider' });
  if (!config.allowGenerate) return res.status(403).json({ ok: false, error: 'Live calls are disabled (FORGE_ALLOW_GENERATE=0).' });
  const modelId = req.body?.modelId ?? PROVIDERS.find((p) => p.id === provider)?.models?.[0]?.id;
  const providedKey = req.body?.key ? String(req.body.key) : null;
  const { plaintext } = keyRepo.get(provider);
  const key = providedKey ?? plaintext;
  if (!key && provider !== 'ollama') return res.status(400).json({ ok: false, error: 'No key configured for this provider.' });
  const result = await testConnection(modelId, key);
  res.json({ ok: result.ok, modelId, ...result });
});
