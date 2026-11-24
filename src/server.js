// =====================================================================
//  Server — webhook + admin API + settings page
//  Railway pe yeh web service chalti hai.
//  Worker ALAG service hai: node src/ivr/worker.js
// =====================================================================
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { validateConfig } from './lib/config.js';
import log from './lib/logger.js';
import { q } from './lib/db.js';
import autoMigrate from './lib/autoMigrate.js';
import ivrRouter from './ivr/router.js';
import { getSettings } from './settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);

// Railway health check — kabhi crash nahi karta, sirf sach batata hai
app.get('/api/health', async (_req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, service: 'retention-ivr', dryRun: config.dryRun, mock: config.exotel.mock });
  } catch (e) {
    res.status(500).json({ ok: false, stage: 'db', error: e.message, code: e.code });
  }
});

// Setup status — "kya kya theek hai" ek nazar me
app.get('/api/ivr/setup', async (_req, res) => {
  const out = { ok: true, checks: {} };
  const check = async (name, fn) => {
    try {
      out.checks[name] = { ok: true, value: await fn() };
    } catch (e) {
      out.checks[name] = { ok: false, error: e.message, code: e.code };
      out.ok = false;
    }
  };

  await check('db', async () => (await q('SELECT 1')).rows[0]['?column?'] === 1);
  await check('view_rows', async () => (await q('SELECT count(*)::int c FROM ivr_callable_customers')).rows[0].c);
  await check('settings', async () => {
    const s = await getSettings({ fresh: true });
    return { company: s.companyName, agent: s.agentNumber, amount: s.minDepositRupees, days: s.noDepositDays };
  });
  await check('callable_now', async () =>
    (
      await q(
        `SELECT count(*)::int c FROM ivr_callable_customers
         WHERE is_active AND NOT do_not_call AND phone_e164 IS NOT NULL
           AND last_deposit_at < now() - make_interval(days => $1)`,
        [(await getSettings()).noDepositDays],
      )
    ).rows[0].c,
  );

  const problems = validateConfig({ needExotel: !config.exotel.mock });
  out.config_problems = problems;
  if (problems.length) out.ok = false;

  res.status(out.ok ? 200 : 503).json(out);
});

// Settings page — agent number yahan se badlo
app.get('/ivr/settings', (_req, res) => res.sendFile(path.join(here, 'public/settings.html')));

app.get('/', (_req, res) =>
  res.json({
    ok: true,
    name: 'dp7-ivr',
    endpoints: ['/api/health', '/api/ivr/setup', '/api/ivr/*', '/ivr/settings'],
  }),
);

app.use('/api/ivr', ivrRouter);

app.use((err, _req, res, _next) => {
  log.error('http.error', { err: err.message });
  res.status(500).json({ ok: false, error: 'internal' });
});

// ---------------------------------------------------------------------
// Boot: migration → health → listen
// ---------------------------------------------------------------------
const problems = validateConfig({ needExotel: !config.exotel.mock });
if (problems.length) {
  // App ko marne ke bajaye chalta rakho — warna console attach nahi hota
  // aur wajah kabhi pata nahi chalti. Health endpoint 503 dega.
  log.error('config.invalid', { problems });
}

(async () => {
  try {
    await autoMigrate();
  } catch (e) {
    log.error('migrate.boot_failed', { err: String(e?.message ?? e), code: e?.code });
  }

  app.listen(config.port, () => {
    log.info('server.started', {
      port: config.port,
      dryRun: config.dryRun,
      mock: config.exotel.mock,
      minDepositRupees: config.minDepositRupees,
      noDepositDays: config.noDepositDays,
      view: config.retentionView,
      configProblems: problems.length,
    });
  });
})();

export default app;

