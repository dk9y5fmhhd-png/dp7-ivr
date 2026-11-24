// =====================================================================
//  DTMF handler — ek jagah, dono raston (webhook + applet event) ke liye
//
//  Mapping (client ne chuna):
//    1 = website link WhatsApp + SMS pe
//    2 = naya ID banao aur bhejo
//    3 = agent se baat
//    9 = DND (aage call nahi)
// =====================================================================
import { q } from '../lib/db.js';
import log from '../lib/logger.js';
import { getSettings } from '../settings.js';

/** Queue me message daalo. Provider na ho to bhi kuch nahi tootta. */
export async function queueMessage({ jobId, customerKey, phone, channel, template, body }) {
  try {
    await q(
      `INSERT INTO ivr_messages (job_id, customer_key, to_phone, channel, template, body, status)
       VALUES ($1,$2,$3,$4,$5,$6,'queued')
       ON CONFLICT (job_id, channel, template) DO NOTHING`,
      [jobId, customerKey, phone, channel, template, body],
    );
  } catch (e) {
    log.warn('message.queue_failed', { err: e.message, template, channel });
  }
}

/** Naya ID — simple, predictable. Aage chaho to apna format lagao. */
export function generateId(username) {
  const clean = String(username ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase() || 'user';
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${clean}${n}`;
}

async function markDnc(job) {
  await q(
    `INSERT INTO ivr_customers (customer_key, name, phone, do_not_call)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (customer_key) DO UPDATE
       SET do_not_call = true, updated_at = now()`,
    [job.customer_key, job.name, job.phone],
  );
  log.warn('customer.opted_out', { customer_key: job.customer_key });
}

/**
 * Ek digit ka poora asar — DB update + outbox.
 * @returns {{action:string, disposition:string, text?:string}}
 */
export async function applyDigit(job, digitRaw) {
  const digit = String(digitRaw ?? '').trim();
  const s = await getSettings();
  const phone = job.phone;

  switch (digit) {
    // 1 — website link WhatsApp + SMS pe
    case '1': {
      const body = `नमस्ते ${job.name} जी, ${s.companyName} की वेबसाइट: ${s.whatsappLink || s.websiteLink || ''}`;
      await queueMessage({ jobId: job.id, customerKey: job.customer_key, phone, channel: 'whatsapp', template: 'website_link', body });
      await queueMessage({ jobId: job.id, customerKey: job.customer_key, phone, channel: 'sms', template: 'website_link', body });
      await q(`UPDATE call_jobs SET digits='1', disposition='link_sent', updated_at=now() WHERE id=$1`, [job.id]);
      log.info('dtmf.link_queued', { jobId: job.id });
      return { action: 'send_link', disposition: 'link_sent' };
    }

    // 2 — naya ID banao aur bhejo
    case '2': {
      const newId = generateId(job.customer_key);
      const body = `नमस्ते ${job.name} जी, आपकी नई आई डी: ${newId}`;
      await queueMessage({ jobId: job.id, customerKey: job.customer_key, phone, channel: 'whatsapp', template: 'new_id', body });
      await queueMessage({ jobId: job.id, customerKey: job.customer_key, phone, channel: 'sms', template: 'new_id', body });
      await q(
        `UPDATE call_jobs SET digits='2', disposition='id_created', new_id=$2, updated_at=now() WHERE id=$1`,
        [job.id, newId],
      ).catch(async () => {
        // column na ho to bhi kaam chale
        await q(`UPDATE call_jobs SET digits='2', disposition='id_created', updated_at=now() WHERE id=$1`, [job.id]);
      });
      log.info('dtmf.id_created', { jobId: job.id, newId });
      return { action: 'new_id', disposition: 'id_created', text: newId };
    }

    // 3 — agent se baat
    case '3': {
      await q(`UPDATE call_jobs SET digits='3', disposition='interested', updated_at=now() WHERE id=$1`, [job.id]);
      log.info('lead.hot', { jobId: job.id, name: job.name, phone });
      return { action: 'agent', disposition: 'interested' };
    }

    // 9 — DND
    case '9': {
      await markDnc(job);
      await q(`UPDATE call_jobs SET digits='9', disposition='opted_out', updated_at=now() WHERE id=$1`, [job.id]);
      return { action: 'opt_out', disposition: 'opted_out' };
    }

    default:
      return { action: 'none', disposition: null };
  }
}

export default { applyDigit, queueMessage, generateId };

