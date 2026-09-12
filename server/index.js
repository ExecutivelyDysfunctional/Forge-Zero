/**
 * Forge-Zero entry point: bind, log, shut down cleanly.
 *
 * All wiring lives in `app.js`. Keeping this file boring is what lets the tests
 * exercise the real routes instead of a mocked approximation of them.
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, stats } from './db.js';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const s = stats();
  console.log(`\n  Forge-Zero ${config.version} — prompt engine for free-tier builds`);
  console.log(`  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`  db ${config.dbPath.replace(process.cwd() + '/', '')} · projects ${s.projects} · packs ${s.packs} · keys ${s.provider_keys}`);
  console.log(`  secret source: ${config.secretSource} · live generation: ${config.allowGenerate ? 'on' : 'off'}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n  closing (${sig})`);
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
