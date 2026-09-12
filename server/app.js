/**
 * Forge-Zero HTTP application factory.
 *
 * One process serves the API and the client. It lives in a factory so the test
 * suite can boot the real app on an ephemeral port, and so `index.js` stays a
 * ten-line entry point that owns binding, logging and shutdown.
 */
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, resolveSecret } from './config.js';
import { getDb, closeDb, stats } from './db.js';
import { metaRouter } from './routes/meta.js';
import { packRouter } from './routes/packs.js';
import { projectRouter } from './routes/projects.js';
import { keyRouter } from './routes/keys.js';
import { generateRouter } from './routes/generate.js';
import { artifacts, runs } from './repo/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

resolveSecret();
getDb();


export function createApp() {
  resolveSecret();
  getDb();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.disable('etag');

  /* ---- security ---- */
  app.use((req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    // Keys and prompts are sensitive; the app is same-origin only. Note the absence
    // of X-Frame-Options/frame-ancestors restrictions: previews embed this UI.
    res.setHeader('content-security-policy', [
      "default-src 'self'",
      "script-src 'self'",
      // Inline style *attributes* are used by the renderer; scripts stay strict.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '));
    next();
  });

  /* ---- tiny in-process limiter: free-tier tools get left running on public hosts ---- */
  const buckets = new Map();
  app.use('/api', (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > config.rateLimit.windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > config.rateLimit.max) {
      res.setHeader('retry-after', String(Math.ceil((config.rateLimit.windowMs - (now - b.start)) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many requests to this Forge-Zero instance. Wait for the window to reset.' });
    }
    if (buckets.size > 5000) buckets.clear();
    next();
  });

  app.use(express.json({ limit: '4mb' }));

  /* ---- api ---- */
  app.get('/api', (_req, res) => res.json({
    ok: true,
    name: 'Forge-Zero',
    version: config.version,
    docs: 'See DESIGN.md for the full contract.',
    endpoints: [
      'GET  /api/health', 'GET  /api/bootstrap', 'GET  /api/constitution',
      'POST /api/models/recommend', 'GET  /api/models/:id', 'GET  /api/providers', 'GET /api/governor',
      'POST /api/packs/compose', 'GET  /api/packs/recent', 'GET  /api/packs/:id',
      'POST /api/packs/:id/verify', 'POST /api/packs/:id/assemble', 'GET  /api/packs/:id/export?format=json|md|curl|bundle',
      'POST /api/packs/repair', 'POST /api/packs/continue',
      'GET/PUT /api/state/workbench',
      'CRUD /api/projects', 'POST /api/projects/:id/packs',
      'GET/PUT/DELETE /api/keys/:provider', 'POST /api/keys/:provider/test',
      'POST /api/generate', 'GET /api/runs',
    ],
  }));

  app.use('/api', metaRouter);
  app.use('/api/packs', packRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/keys', keyRouter);
  app.use('/api', generateRouter);

  app.get('/api/runs', (req, res) => {
    res.json({ ok: true, runs: runs.recent(Number.parseInt(req.query.limit ?? '25', 10)), stats: stats() });
  });

  /**
   * Sandboxed preview of an assembled single-file artifact.
   *
   * Served from its own path with its own CSP and `sandbox` semantics rather than a
   * srcdoc iframe: the generated app may reference CDN scripts, and it must never be
   * able to read this origin's localStorage or call /api with the user's keys.
   */
  app.get('/preview/:artifactId', (req, res) => {
    const row = artifacts.get(req.params.artifactId);
    if (!row) return res.status(404).type('text/plain').send('Artifact not found');
    res.setHeader('content-security-policy', [
      "default-src 'none'",
      "script-src 'unsafe-inline' https:",
      "style-src 'unsafe-inline' https:",
      "img-src data: https:",
      "font-src data: https:",
      "connect-src https:",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '));
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('x-robots-tag', 'noindex');
    res.type('text/html').send(injectPreviewHarness(row.text));
  });

  function injectPreviewHarness(html) {
    if (!/<html/i.test(html)) return html;
    const harness = `<script>(function(){
    function report(msg){ try { parent.postMessage({ source: 'forge-preview', level: 'error', message: String(msg) }, '*'); } catch (e) {} }
    window.addEventListener('error', function (e) { report(e.message + ' @' + (e.filename||'') + ':' + (e.lineno||0)); });
    window.addEventListener('unhandledrejection', function (e) { report('Unhandled rejection: ' + (e.reason && e.reason.message || e.reason)); });
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-action]') : null;
      if (el) { try { parent.postMessage({ source: 'forge-preview', level: 'action', action: el.getAttribute('data-action') }, '*'); } catch (err) {} }
    });
  })();</script>`;
    return html.replace(/<\/head>/i, harness + '</head>').replace(/<\/body>/i, harness + '</body>');
  }

  /* ---- client ---- */
  app.use(express.static(join(here, '..', 'client'), {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, path) {
      if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      else res.setHeader('cache-control', config.env === 'production' ? 'public, max-age=3600' : 'no-store');
    },
  }));

  app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'Unknown API route. GET /api lists them.' }));
  app.use((_req, res) => res.status(404).type('text/html').send('<!doctype html><meta charset="utf-8"><title>404</title><p style="font:16px ui-monospace,monospace;padding:2rem">Not found. <a href="/">Back to the workbench</a>'));

  app.use((err, _req, res, _next) => {
    const payload = { ok: false, error: err?.message ?? String(err) };
    if (config.env !== 'production') payload.stack = (err?.stack ?? '').split('\n').slice(0, 6);
    if (err?.type === 'entity.parse.failed') { payload.error = 'Request body is not valid JSON.'; res.status(400).json(payload); return; }
    console.error('[forge-zero] unhandled', err?.message ?? err);
    res.status(err?.status ?? 500).json(payload);
  });


  return app;
}
