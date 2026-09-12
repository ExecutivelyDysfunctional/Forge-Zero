/**
 * Saved briefs. A pack is cheap to re-compose, so a project stores the *brief*
 * and options, not the rendered text - which keeps the row small and means a
 * catalogue update silently improves every stored project on next open.
 */
import { Router } from 'express';
import { projects, packs } from '../repo/index.js';
import { normalizeSpec } from '../lib/spec.js';
import { composePack } from '../lib/composer.js';
import { packRecord } from './packs.js';

export const projectRouter = Router();

projectRouter.get('/', (_req, res) => res.json({ ok: true, projects: projects.list() }));

projectRouter.post('/', (req, res) => {
  const { name, mode = 'single-file', spec = {}, modelId = null, options = {} } = req.body ?? {};
  const normalized = normalizeSpec({ ...spec, mode }, mode);
  if (!normalized.ok) return res.status(422).json({ ok: false, errors: normalized.errors, warnings: normalized.warnings });
  const row = projects.create({ name: name ?? normalized.spec.name, mode: normalized.spec.mode, modelId, spec: normalized.spec, options });
  res.status(201).json({ ok: true, project: row });
});

projectRouter.get('/:id', (req, res) => {
  const row = projects.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Project not found' });
  res.json({ ok: true, project: row });
});

projectRouter.put('/:id', (req, res) => {
  const body = req.body ?? {};
  const mode = body.mode ?? undefined;
  let spec = body.spec;
  if (spec || mode) {
    const normalized = normalizeSpec({ ...(spec ?? {}), ...(mode ? { mode } : {}) }, mode ?? body.mode ?? 'single-file');
    if (!normalized.ok) return res.status(422).json({ ok: false, errors: normalized.errors });
    spec = normalized.spec;
  }
  const row = projects.update(req.params.id, { name: body.name, mode: body.mode, modelId: body.modelId, spec, options: body.options });
  if (!row) return res.status(404).json({ ok: false, error: 'Project not found' });
  res.json({ ok: true, project: row });
});

projectRouter.delete('/:id', (req, res) => {
  const ok = projects.remove(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

/** Compose and attach a pack to the project in one call (the "Generate" button). */
projectRouter.post('/:id/packs', (req, res) => {
  const row = projects.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Project not found' });
  const modelId = req.body?.modelId ?? row.model_id ?? undefined;
  const options = { ...(row.options ?? {}), ...(req.body?.options ?? {}) };
  const pack = composePack({ mode: row.mode, spec: row.spec, modelId, options });
  const id = packs.save(packRecord(row.id, pack));
  res.status(201).json({ ok: true, packId: id, pack });
});
