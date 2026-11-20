// =====================================================================
//  IVR Worker — campaign + dialing + retry
//  Settings DB se aati hain (agent number, amount, days) — redeploy
//  ke bina badal sakte ho.
//  Alag Railway service: node src/ivr/worker.js
// =====================================================================
import config from '../lib/config.js';
import log from '../lib/logger.js';
import { q, pool } from '../lib/db.js';
import { isoWeekKey } from '../lib/cycle.js';
import { connectCall } from './exotel.js';
import { getSettings, withinCallWindow } from '../settings.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// 1. Advisory lock — 2 instance ho to sirf ek dial kare
// ---------------------------------------------------------------------
let lockClient = null;

export async function acquireLock() {
  lockClient = await pool.connect();
  const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [
    config.advisorLockId,
  ]);
  if (!rows[0].ok) {
    lockClient.release();
    lockClient = null;
    return false;
  }
  return true;
}

export async function releaseLock() {
  if (!lockClient) return;
  try {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [config.advisorLockId]);
  } catch {
    /* ignore */
  }
  lockClient.release();
  lockClient = null;
}

// ---------------------------------------------------------------------
// 2. Rate limiter
// ---------------------------------------------------------------------
const dialTimes = [];
function canDialNow() {
  const cutoff = Date.now() - 60_000;
  while (dialTimes.length && dialTimes[0] < cutoff) dialTimes.shift();
  return dialTimes.length < config.callsPerMinute;
}
async function waitForSlot() {
  while (!canDialNow()) await sleep(1000);
  dialTimes.push(Date.now());
}

// ---------------------------------------------------------------------
// 3. Campaign
// ---------------------------------------------------------------------
export async function buildCampaign(cycleKey = isoWeekKey(), settings = null) {
  const s = settings ?? (await getSettings({ fresh: true }));
  const sql = `
    INSERT INTO call_jobs (customer_key, name, phone, reason, cycle_key, attempt, status)
    SELECT v.customer_key,
           v.name,
           COALESCE(v.phone_e164, v.phone),
           'no_deposit_7d',
           $1,
           1,
           'pending'
    FROM   ${config.retentionView} v
    WHERE  v.is_active = true
      AND  v.do_not_call = false
      AND  v.phone_e164 IS NOT NULL
      AND  COALESCE(v.last_deposit_at, '-infinity'::timestamptz)
             < now() - make_interval(days => $2)
    ON CONFLICT (customer_key, reason, cycle_key) DO NOTHING
    RETURNING id, customer_key, name, phone
  `;
  const { rows } = await q(sql, [cycleKey, s.noDepositDays]);
  log.info('campaign.built', { cycleKey, created: rows.length, dryRun: config.dryRun, days: s.noDepositDays });
  return rows;
}

// ---------------------------------------------------------------------
// 4. Retry
// ---------------------------------------------------------------------
export async function scheduleRetries(settings = null) {
  const s = settings ?? (await getSettings({ fresh: true }));
  const sql = `
    UPDATE call_jobs
    SET    status = 'pending',
           attempt = attempt + 1,
           next_attempt_at = NULL,
           updated_at = now()
    WHERE  status IN ('no_answer', 'busy', 'failed')
      AND  attempt < $1
      AND  COALESCE(next_attempt_at, now()) <= now()
    RETURNING id
  `;
  const { rows } = await q(sql, [s.maxAttempts]);
  if (rows.length) log.info('retries.scheduled', { count: rows.length });
  return rows;
}

// ---------------------------------------------------------------------
// 5. Dial queue
// ---------------------------------------------------------------------
export async function dialQueue(limit = 25, settings = null) {
  const s = settings ?? (await getSettings({ fresh: true }));

  if (!withinCallWindow(s)) {
    log.info('dialing.outside_window', { from: s.callWindowStart, to: s.callWindowEnd });
    return [];
  }

  const sql = `
    SELECT j.id, j.customer_key, j.name, j.phone, j.attempt,
           v.min_deposit_rupees
    FROM   call_jobs j
    JOIN   ${config.retentionView} v ON v.customer_key = j.customer_key
    WHERE  j.status = 'pending'
      AND  j.attempt <= $3
      AND  v.is_active = true
      AND  v.do_not_call = false
      AND  v.phone_e164 IS NOT NULL
      AND  COALESCE(v.last_deposit_at, '-infinity'::timestamptz)
             < now() - make_interval(days => $1)
    ORDER BY j.created_at
    LIMIT $2
  `;
  const { rows } = await q(sql, [s.noDepositDays, limit, s.maxAttempts]);
  const results = [];

  for (const job of rows) {
    if (config.dryRun) {
      log.info('dry_run.would_call', {
        jobId: job.id,
        name: job.name,
        phone: job.phone,
        attempt: job.attempt,
        agent: s.agentNumber,
        amount: s.minDepositRupees,
      });
      results.push({ jobId: job.id, outcome: 'dry_run' });
      continue;
    }

    await waitForSlot();

    await q(
      `UPDATE call_jobs SET status = 'calling', called_at = now(), updated_at = now() WHERE id = $1`,
      [job.id],
    );

    try {
      const res = await connectCall({ to: job.phone, jobId: job.id });
      await q(
        `UPDATE call_jobs
            SET provider_call_sid = $2, status = 'calling', error = NULL, updated_at = now()
          WHERE id = $1`,
        [job.id, res.sid],
      );
      log.info('call.dialed', { jobId: job.id, sid: res.sid, attempt: job.attempt });
      results.push({ jobId: job.id, outcome: 'dialed', sid: res.sid });
    } catch (err) {
      const nextAttempt = job.attempt + 1;
      const retry = nextAttempt <= s.maxAttempts;
      await q(
        `UPDATE call_jobs
            SET status = 'failed',
                error = $2,
                attempt = $3,
                next_attempt_at = CASE WHEN $4 THEN now() + make_interval(hours => $5) ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [job.id, String(err.message).slice(0, 300), job.attempt, retry, config.retryAfterHours],
      );
      log.error('call.dial_failed', { jobId: job.id, err: err.message });
      results.push({ jobId: job.id, outcome: 'failed', error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------
// 6. Ek cycle
// ---------------------------------------------------------------------
export async function runOnce({ forceCampaign = false } = {}) {
  const cycleKey = isoWeekKey();
  const settings = await getSettings({ fresh: true });
  let created = 0;
  if (forceCampaign) created = (await buildCampaign(cycleKey, settings)).length;
  await scheduleRetries(settings);
  const dialed = await dialQueue(25, settings);
  return { cycleKey, created, dialed };
}

// ---------------------------------------------------------------------
// 7. Cron matcher
// ---------------------------------------------------------------------
function localParts(now, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = fmt.format(now).split(':').map(Number);
  return { h, m };
}

export function cronMatches(expr, now = new Date(), tz = config.cronTz) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const { h, m } = localParts(now, tz);
  const match = (field, value) => {
    if (field === '*') return true;
    if (field.startsWith('*/')) return value % Number(field.slice(2)) === 0;
    return field.split(',').map(Number).includes(value);
  };
  return match(parts[0], m) && match(parts[1], h);
}

// ---------------------------------------------------------------------
// 8. Loop
// ---------------------------------------------------------------------
let lastCampaignDay = null;
let stopping = false;

export async function startWorker() {
  const gotLock = await acquireLock();
  if (!gotLock) {
    log.warn('worker.no_lock', { msg: 'doosra instance chal raha hai — yeh exit ho raha hai' });
    await pool.end();
    return;
  }

  const s = await getSettings({ fresh: true });
  log.info('worker.started', {
    dryRun: config.dryRun,
    mock: config.exotel.mock,
    callsPerMinute: config.callsPerMinute,
    company: s.companyName,
    agentNumber: s.agentNumber,
    minDepositRupees: s.minDepositRupees,
    noDepositDays: s.noDepositDays,
    view: config.retentionView,
  });

  const shutdown = async (sig) => {
    stopping = true;
    log.info('worker.shutdown', { sig });
    await releaseLock();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  while (!stopping) {
    try {
      const now = new Date();
      const todayKey = now.toISOString().slice(0, 10);
      const campaignDue = cronMatches(config.campaignCron, now) && lastCampaignDay !== todayKey;

      const res = await runOnce({ forceCampaign: campaignDue });
      if (campaignDue) lastCampaignDay = todayKey;
      if (res.created || res.dialed.length) log.info('worker.cycle', res);
    } catch (err) {
      log.error('worker.cycle_failed', { err: err.message });
    }
    await sleep(config.pollSeconds * 1000);
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('worker.js');
if (isMain) {
  startWorker().catch(async (e) => {
    log.error('worker.crashed', { err: e.message });
    process.exit(1);
  });
}

