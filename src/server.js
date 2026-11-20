// =====================================================================
//  Server — webhook + admin API. Railway pe yeh web service chalti hai.
//  Worker ALAG service hai: node src/ivr/worker.js
// =====================================================================
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { validateConfig } from './lib/config.js';
import log from './lib/logger.js';
import { q } from './lib/db.js';
import ivrRouter from './ivr/router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);

// Railway health check
app.get('/api/health', async (_req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, service: 'retention-ivr', dryRun: config.dryRun });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Settings page — agent number yahan se badlo
app.get('/ivr/settings', (_req, res) => res.sendFile(path.join(here, 'public/settings.html')));

app.get('/', (_req, res) =>
  res.json({
    ok: true,
    name: 'retention-ivr',
    endpoints: ['/api/health', '/api/ivr/*', '/ivr/settings'],
  }),
);

app.use('/api/ivr', ivrRouter);

app.use((err, _req, res, _next) => {
  log.error('http.error', { err: err.message });
  res.status(500).json({ ok: false, error: 'internal' });
});

const problems = validateConfig({ needExotel: !config.exotel.mock });
if (problems.length) {
  log.error('config.invalid', { problems });
  if (config.env === 'production' && !config.exotel.mock) process.exit(1);
}

app.listen(config.port, () => {
  log.info('server.started', {
    port: config.port,
    dryRun: config.dryRun,
    mock: config.exotel.mock,
    minDepositRupees: config.minDepositRupees,
    view: config.retentionView,
  });
});

export default app;


