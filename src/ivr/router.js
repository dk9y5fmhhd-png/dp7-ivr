// =====================================================================
//  /api/ivr/* — webhook, DTMF events, passthru, admin, import
// =====================================================================
import express from 'express';
import crypto from 'node:crypto';
import config from '../lib/config.js';
import log from '../lib/logger.js';
import { q } from '../lib/db.js';
import { isoWeekKey } from '../lib/cycle.js';
import { flattenPayload, mapStatus, pick } from './exotel.js';
import * as scripts from './script.js';
import { buildCallScript } from './script.js';
import { applyDigit, queueMessage } from './dtmf.js';
import { importRetentionCsv } from '../retention/import.js';
import { importDepositFile } from '../retention/depositImport.js';
import { EDITABLE, getSettings, updateSettings, validateSetting } from '../settings.js';

const router = express.Router();

// ---------------------------------------------------------------------
// token compare — timing safe
// ---------------------------------------------------------------------
function safeEqual(a = '', b = '') {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function webhookOk(req) {
  if (!config.tokens.webhook) return false;
  const t = req.query.token ?? req.get('x-ivr-token') ?? '';
  return safeEqual(t, config.tokens.webhook);
}

function adminOk(req) {
  if (!config.tokens.admin) return false;
  const t = req.get('x-admin-token') ?? req.query.token ?? '';
  return safeEqual(t, config.tokens.admin);
}

const requireAdmin = (req, res, next) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
};

// ---------------------------------------------------------------------
// Job dhoondo — SID se, ya CustomField (job id) se
// ---------------------------------------------------------------------
async function findJob({ sid, customField }) {
  if (sid) {
    const { rows } = await q('SELECT * FROM call_jobs WHERE provider_call_sid = $1 LIMIT 1', [sid]);
    if (rows[0]) return rows[0];
  }
  const numeric = Number.parseInt(String(customField ?? ''), 10);
  if (Number.isFinite(numeric)) {
    const { rows } = await q('SELECT * FROM call_jobs WHERE id = $1 LIMIT 1', [numeric]);
    if (rows[0]) return rows[0];
  }
  return null;
}

async function markDnc(job) {
  await q('UPDATE ivr_customers SET do_not_call = true, updated_at = now() WHERE customer_key = $1', [
    job.customer_key,
  ]);
  log.warn('customer.opted_out', { customer_key: job.customer_key });
}

// ---------------------------------------------------------------------
// Status webhook — Exotel call khatam hone pe bhejta hai
//   1) 200 turant, 2) phir async process
// ---------------------------------------------------------------------
router.post(
  '/webhook',
  express.urlencoded({ extended: true, limit: '64kb' }),
  express.json({ limit: '64kb' }),
  (req, res) => {
  if (!webhookOk(req)) {
    log.warn('webhook.bad_token', { ip: req.ip });
    return res.status(403).json({ ok: false });
  }

  const flat = flattenPayload(req.body ?? {});
  res.status(200).json({ ok: true }); // provider ko turant jawab, warna retry loop

  setImmediate(() => {
    processStatusEvent(flat, req.body ?? {}).catch((e) =>
      log.error('webhook.process_failed', { err: e.message }),
    );
  });
});

export async function processStatusEvent(flat, rawBody) {
  const sid = pick(flat, 'CallSid', 'Sid', 'CallId', 'call_sid');
  const customField = pick(flat, 'CustomField', 'custom_field');
  const statusRaw = pick(flat, 'Status', 'CallStatus', 'status');
  const status = mapStatus(statusRaw);
  const duration = Number(pick(flat, 'Duration', 'ConversationDuration', 'duration') ?? 0) || 0;
  const recording = pick(flat, 'RecordingUrl', 'RecordingURL', 'recording_url') ?? null;
  const digits = pick(flat, 'Digits', 'DtmfDigits', 'digits') ?? null;

  const job = await findJob({ sid, customField });
  if (!job) {
    log.warn('webhook.job_not_found', { sid, customField, status: statusRaw });
    return;
  }

  // raw payload hamesha save — mapping baad me verify karne ke liye
  const ins = await q(
    `INSERT INTO call_events (provider_call_sid, job_id, kind, step, digits, payload)
     VALUES ($1,$2,'status','',$3,$4)
     ON CONFLICT (provider_call_sid, kind, step) DO NOTHING
     RETURNING id`,
    [sid ?? job.provider_call_sid ?? '', job.id, digits, JSON.stringify(rawBody)],
  );
  if (!ins.rows.length) {
    // provider ne same event dobara bheja — storage dedupe ho gaya,
    // lekin processing idempotent hai to aage badhne do
    log.info('webhook.duplicate_event', { jobId: job.id, status: statusRaw });
  }

  const effectiveDigits = digits ?? job.digits;

  // DTMF SIRF tab process karo jab payload me aaya ho.
  // (job.digits me pichli call ka digit pada hota hai — use dobara
  //  apply karna galat tha: har webhook pe wahi action dohraata tha.)
  if (digits && String(digits).trim()) {
    const res = await applyDigit(job, digits);
    if (res.action !== 'none') {
      // digit ke saath status bhi set karo — warna job 'calling' pe atki rehti
      const finalStatus = status === 'completed' ? 'completed' : job.status;
      await q(
        `UPDATE call_jobs
            SET status = $2,
                duration_sec = COALESCE($3, duration_sec),
                recording_url = COALESCE($4, recording_url),
                updated_at = now()
          WHERE id = $1`,
        [job.id, finalStatus, duration || null, recording],
      );
      return;
    }
  }

  if (status === 'completed') {
    // 5 sec se kam = asal me baat nahi hui, no-answer maano
    if (duration > 0 && duration < 5) {
      await q(
        `UPDATE call_jobs SET status='no_answer', duration_sec=$2, digits=$3,
                recording_url=COALESCE($4, recording_url), updated_at=now()
          WHERE id=$1`,
        [job.id, duration, effectiveDigits, recording],
      );
      return;
    }

    let disposition = 'informed';
    if (String(effectiveDigits) === '1') disposition = 'link_sent';
    else if (String(effectiveDigits) === '2') disposition = 'id_created';
    else if (String(effectiveDigits) === '3') disposition = 'interested';
    else if (String(effectiveDigits) === '9') disposition = 'opted_out';

    await q(
      `UPDATE call_jobs SET status='completed', disposition=$2, duration_sec=$3, digits=$4,
              recording_url=COALESCE($5, recording_url), error=NULL, updated_at=now()
        WHERE id=$1`,
      [job.id, disposition, duration, effectiveDigits, recording],
    );
    log.info('call.completed', { jobId: job.id, disposition, duration });
    return;
  }

  if (['no_answer', 'busy', 'failed'].includes(status)) {
    const exhausted = job.attempt >= config.maxAttempts;
    await q(
      `UPDATE call_jobs SET status=$2, duration_sec=$3, error=$4,
              recording_url=COALESCE($5, recording_url),
              disposition = CASE WHEN $6 THEN 'exhausted' ELSE disposition END,
              next_attempt_at = CASE WHEN $6 THEN NULL ELSE now() + make_interval(hours => $7) END,
              updated_at=now()
        WHERE id=$1`,
      [job.id, status, duration, statusRaw?.toString().slice(0, 120) ?? null, recording, exhausted, config.retryAfterHours],
    );
    log.info('call.not_connected', { jobId: job.id, status, exhausted });
    return;
  }

  if (status === 'in_progress') {
    await q(`UPDATE call_jobs SET status='calling', updated_at=now() WHERE id=$1 AND status <> 'completed'`, [
      job.id,
    ]);
    return;
  }

  log.info('webhook.status_unknown', { jobId: job.id, statusRaw });
}

// ---------------------------------------------------------------------
// DTMF event — applet branch se. Customer ne kaunsa button dabaya.
// SYNC hai: applet ko turant text chahiye (Play applet ke liye), isliye
// yahan setImmediate nahi — seedha process karke text wapas.
// ---------------------------------------------------------------------
router.post('/event', express.json({ limit: '64kb' }), express.urlencoded({ extended: true }), async (req, res) => {
  if (!webhookOk(req)) return res.status(403).json({ ok: false });

  const step = String(req.query.step ?? req.body?.step ?? '').trim();
  const flat = flattenPayload(req.body ?? {});
  const sid = pick(flat, 'CallSid', 'Sid', 'CallId') ?? req.query.sid;
  const customField = pick(flat, 'CustomField') ?? req.query.job;
  const digits = pick(flat, 'Digits', 'digits') ?? (step.match(/^digit(\d)$/)?.[1] ?? null);

  try {
    const job = await findJob({ sid, customField });
    if (!job) {
      log.warn('event.job_not_found', { sid, step, customField });
      return res.json({ ok: true, action: 'none', say: scripts.noInputPrompt(), text: scripts.noInputPrompt() });
    }

    // raw payload hamesha — debugging ka jaan
    await q(
      `INSERT INTO call_events (provider_call_sid, job_id, kind, step, digits, payload)
       VALUES ($1,$2,'dtmf',$3,$4,$5)
       ON CONFLICT (provider_call_sid, kind, step) DO NOTHING`,
      [sid ?? job.provider_call_sid ?? '', job.id, step || String(digits ?? 'unknown'), digits, JSON.stringify(req.body ?? {})],
    );

    const s = await getSettings();
    const base = { name: job.name, company: s.companyName, supportNumber: s.supportNumber };

    if (!digits) {
      const t = scripts.noInputPrompt();
      return res.json({ ok: true, action: 'no_input', say: t, text: t });
    }

    const res1 = await applyDigit(job, digits);

    let text = scripts.closing();
    if (res1.action === 'send_link') text = scripts.linkSent();
    else if (res1.action === 'new_id') text = scripts.idCreated({ newId: res1.text });
    else if (res1.action === 'agent') text = scripts.agentTransfer();
    else if (res1.action === 'opt_out') text = scripts.optOut(base);

    log.info('event.processed', { jobId: job.id, step, digits, action: res1.action });

    // Exotel ke alag-alag applet shapes ke liye teeno keys
    return res.json({ ok: true, action: res1.action, disposition: res1.disposition, say: text, text, new_id: res1.text ?? null });
  } catch (e) {
    log.error('event.process_failed', { err: String(e?.message ?? e), code: e?.code, stack: e?.stack });
    const t = 'कृपया प्रतीक्षा कीजिए।';
    return res.status(200).json({ ok: false, action: 'error', say: t, text: t });
  }
});

// ---------------------------------------------------------------------
// Passthru — applet yahan se per-customer Hindi text leta hai
// NOTE: response shape Exotel ke current docs pe confirm karna hai.
// ---------------------------------------------------------------------
router.post('/passthru', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  if (!webhookOk(req)) return res.status(403).json({ ok: false });

  const flat = flattenPayload(req.body ?? {});
  const sid = pick(flat, 'CallSid', 'Sid');
  const customField = pick(flat, 'CustomField') ?? req.query.job;
  const job = await findJob({ sid, customField });

  if (!job) {
    return res.json({ text: 'कृपया प्रतीक्षा कीजिए।', say: 'कृपया प्रतीक्षा कीजिए।' });
  }

  const { rows } = await q('SELECT * FROM ivr_callable_customers WHERE customer_key = $1', [job.customer_key]);
  const customer = rows[0] ?? { name: job.name, min_deposit_rupees: config.minDepositRupees };
  const s = await getSettings();

  const { block, text } = buildCallScript(
    { ...customer, attempt: job.attempt },
    {
      company: s.companyName,
      supportNumber: s.supportNumber,
      whatsappLink: s.whatsappLink,
      amountRupees: s.minDepositRupees,
      days: s.noDepositDays,
    },
  );

  log.info('passthru.served', { jobId: job.id, block });
  // teeno shapes bhej dete hain taaki applet jo maange mil jaaye
  res.json({ text, say: text, audio_text: text, block });
});

// ---------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------
router.get('/jobs', requireAdmin, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const limit = Math.min(Number.parseInt(req.query.limit ?? '100', 10) || 100, 500);
  const { rows } = await q(
    `SELECT id, customer_key, name, phone, attempt, status, disposition, digits,
            duration_sec, recording_url, next_attempt_at, called_at, created_at
       FROM call_jobs
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [status, limit],
  );
  res.json({ ok: true, count: rows.length, jobs: rows });
});

router.get('/stats', requireAdmin, async (req, res) => {
  const { rows } = await q(
    `SELECT
       COALESCE(SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END),0)::int AS pending,
       COALESCE(SUM(CASE WHEN status='calling'   THEN 1 ELSE 0 END),0)::int AS calling,
       COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0)::int AS completed,
       COALESCE(SUM(CASE WHEN status='no_answer' THEN 1 ELSE 0 END),0)::int AS no_answer,
       COALESCE(SUM(CASE WHEN status='busy'      THEN 1 ELSE 0 END),0)::int AS busy,
       COALESCE(SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END),0)::int AS failed,
       COALESCE(SUM(CASE WHEN disposition='link_sent'   THEN 1 ELSE 0 END),0)::int AS link_sent,
       COALESCE(SUM(CASE WHEN disposition='id_created'  THEN 1 ELSE 0 END),0)::int AS id_created,
       COALESCE(SUM(CASE WHEN disposition='interested'  THEN 1 ELSE 0 END),0)::int AS agent_transfer,
       COALESCE(SUM(CASE WHEN disposition='opted_out'   THEN 1 ELSE 0 END),0)::int AS opted_out,
       COALESCE(SUM(CASE WHEN disposition='exhausted'     THEN 1 ELSE 0 END),0)::int AS exhausted,
       COALESCE(ROUND(AVG(NULLIF(duration_sec,0))),0)::int AS avg_duration
     FROM call_jobs
     WHERE created_at > now() - interval '30 days'`,
  );
  const { rows: cust } = await q(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE do_not_call)::int AS dnc,
            COUNT(*) FILTER (WHERE is_active)::int AS active
       FROM ivr_customers`,
  );
  res.json({ ok: true, cycle: isoWeekKey(), jobs: rows[0], customers: cust[0] });
});

router.post('/jobs/:id/recall', requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { rows } = await q(
    `UPDATE call_jobs
        SET status='pending', next_attempt_at=NULL, error=NULL, updated_at=now()
      WHERE id=$1 AND status <> 'calling'
      RETURNING id, customer_key, name, phone, attempt`,
    [id],
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'job nahi mila ya abhi call chal rahi hai' });
  log.info('job.recall_queued', { jobId: id });
  res.json({ ok: true, job: rows[0] });
});

router.get('/preview', requireAdmin, async (req, res) => {
  const key = String(req.query.customer_key ?? '');
  const attempt = Number.parseInt(req.query.attempt ?? '1', 10);
  const { rows } = await q('SELECT * FROM ivr_callable_customers WHERE customer_key = $1', [key]);
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'customer nahi mila' });
  const s = await getSettings();
  const out = buildCallScript(
    { ...rows[0], attempt },
    {
      company: s.companyName,
      supportNumber: s.supportNumber,
      amountRupees: s.minDepositRupees,
      days: s.noDepositDays,
    },
  );
  res.json({ ok: true, attempt, ...out });
});

// ---------------------------------------------------------------------
// Settings — agent number yahan se badlo, redeploy ki zaroorat nahi
// ---------------------------------------------------------------------
router.get('/settings', requireAdmin, async (_req, res) => {
  const s = await getSettings({ fresh: true });
  const meta = Object.entries(EDITABLE).map(([key, def]) => ({
    key,
    label: def.label,
    type: def.type,
    value: s.raw[key],
  }));
  res.json({
    ok: true,
    settings: {
      companyName: s.companyName,
      agentNumber: s.agentNumber,
      supportNumber: s.supportNumber,
      whatsappLink: s.whatsappLink,
      websiteLink: s.websiteLink,
      minDepositRupees: s.minDepositRupees,
      noDepositDays: s.noDepositDays,
      maxAttempts: s.maxAttempts,
      callWindowStart: s.callWindowStart,
      callWindowEnd: s.callWindowEnd,
    },
    fields: meta,
  });
});

router.put('/settings', requireAdmin, express.json({ limit: '32kb' }), async (req, res) => {
  const patch = req.body ?? {};
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'kuch bheja nahi' });

  const { applied, errors } = await updateSettings(patch, { by: req.get('x-admin-user') ?? 'admin' });
  if (!Object.keys(applied).length) return res.status(400).json({ ok: false, errors });
  res.json({ ok: true, applied, errors });
});

// Agent number alag se — chhota endpoint, dialer/screen ke liye
router.get('/agent', async (req, res) => {
  if (!webhookOk(req) && !adminOk(req)) return res.status(403).json({ ok: false });
  const s = await getSettings();
  res.json({ ok: true, agent_number: s.agentNumber, company: s.companyName });
});

// CSV upload — retention panel ka export seedha yahan
router.post(
  '/import',
  requireAdmin,
  express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '10mb' }),
  async (req, res) => {
    const csv =
      typeof req.body === 'string' && req.body.length > 0
        ? req.body
        : String(req.query.csv ?? '');
    if (!csv) return res.status(400).json({ ok: false, error: 'CSV body khaali hai' });

    const result = await importRetentionCsv(csv, {
      filename: String(req.query.filename ?? 'upload.csv'),
      source: 'api',
    });
    res.json({ ok: true, ...result });
  },
);

router.get('/syncs', requireAdmin, async (_req, res) => {
  const { rows } = await q(
    `SELECT id, filename, rows_in, rows_ok, rows_bad, created_at
       FROM retention_syncs ORDER BY created_at DESC LIMIT 20`,
  );
  res.json({ ok: true, syncs: rows });
});

// ---------------------------------------------------------------------
// Daily deposit file upload — XLSX ya CSV, dono
//   curl -X POST "$BASE/api/ivr/import-deposits?filename=20-11.xlsx" \
//        -H "x-admin-token: $T" --data-binary @20-11.xlsx
// ---------------------------------------------------------------------
router.post(
  '/import-deposits',
  requireAdmin,
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!buf.length) return res.status(400).json({ ok: false, error: 'file khaali hai' });

    const filename = String(req.query.filename ?? 'deposits.xlsx');
    // XLSX ek ZIP hai — PK se shuru hota hai
    const isXlsx =
      (buf[0] === 0x50 && buf[1] === 0x4b) || /\.xlsx?$/i.test(filename) || /spreadsheetml/.test(req.get('content-type') ?? '');

    try {
      const result = await importDepositFile(buf, { filename, isXlsx });
      res.status(result.ok ? 200 : 422).json(result);
    } catch (err) {
      log.error('deposits.import_failed', { err: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

router.get('/uploads', requireAdmin, async (_req, res) => {
  const { rows } = await q(
    `SELECT id, filename, rows_in, rows_new, rows_dup, rows_bad, users_seen, created_at
       FROM deposit_uploads ORDER BY created_at DESC LIMIT 30`,
  );
  res.json({ ok: true, uploads: rows });
});

// WhatsApp / SMS outbox — provider lagne pe bas yeh uthana hai
router.get('/messages', requireAdmin, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const { rows } = await q(
    `SELECT id, job_id, customer_key, to_phone, channel, template, status, created_at, sent_at
       FROM ivr_messages
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC LIMIT 100`,
    [status],
  );
  res.json({ ok: true, count: rows.length, messages: rows });
});

// Ek user ka deposit history — "uska last deposit kab tha" ka jawab
router.get('/deposits', requireAdmin, async (req, res) => {
  const username = String(req.query.username ?? '').trim();
  if (!username) return res.status(400).json({ ok: false, error: 'username chahiye' });

  const { rows } = await q(
    `SELECT deposit_at, amount_rupees, txn_ref, source_file
       FROM ivr_deposits WHERE lower(username) = lower($1)
      ORDER BY deposit_at DESC LIMIT 50`,
    [username],
  );
  const { rows: v } = await q(
    `SELECT customer_key, name, phone_e164, last_deposit_at, deposit_count,
            total_deposited_rupees,
            EXTRACT(EPOCH FROM (now() - last_deposit_at)) / 86400 AS days_since
       FROM ivr_callable_customers WHERE lower(customer_key) = lower($1)`,
    [username],
  );
  res.json({ ok: true, username, summary: v[0] ?? null, deposits: rows });
});

router.get('/health', async (_req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, cycle: isoWeekKey(), dryRun: config.dryRun });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;



















