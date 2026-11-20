// Retention CSV -> ivr_customers (upsert) + sync log
import { q } from '../lib/db.js';
import { normalizePhone } from '../lib/phone.js';
import config from '../lib/config.js';
import { parseRetentionCsv } from './csv.js';

export async function importRetentionCsv(csvText, { filename = 'upload.csv', source = 'csv' } = {}) {
  const { rows, bad } = parseRetentionCsv(csvText);

  let ok = 0;
  const rejected = [...bad];

  for (const r of rows) {
    const e164 = normalizePhone(r.phone);
    if (!e164) {
      rejected.push({ customer_key: r.customer_key, reason: `phone invalid: ${r.phone}` });
      continue;
    }
    try {
      await q(
        `INSERT INTO ivr_customers
           (customer_key, name, name_hi, phone, last_deposit_at, min_deposit_rupees, is_active, do_not_call, language, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (customer_key) DO UPDATE SET
           name              = EXCLUDED.name,
           name_hi           = EXCLUDED.name_hi,
           phone             = EXCLUDED.phone,
           last_deposit_at   = EXCLUDED.last_deposit_at,
           min_deposit_rupees= COALESCE(EXCLUDED.min_deposit_rupees, ivr_customers.min_deposit_rupees),
           is_active         = EXCLUDED.is_active,
           do_not_call       = ivr_customers.do_not_call OR EXCLUDED.do_not_call,
           language          = EXCLUDED.language,
           source            = EXCLUDED.source,
           updated_at        = now()`,
        [
          r.customer_key,
          r.name,
          r.name_hi ?? null,
          e164,
          r.last_deposit_at ? r.last_deposit_at.toISOString() : null,
          r.min_deposit_rupees ?? config.minDepositRupees,
          r.is_active,
          r.do_not_call,
          r.language,
          source,
        ],
      );
      ok++;
    } catch (err) {
      rejected.push({ customer_key: r.customer_key, reason: err.message });
    }
  }

  const { rows: sync } = await q(
    `INSERT INTO retention_syncs (filename, rows_in, rows_ok, rows_bad, bad_reasons)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [filename, rows.length + bad.length, ok, rejected.length, JSON.stringify(rejected.slice(0, 50))],
  );

  return {
    syncId: sync[0].id,
    rowsIn: rows.length + bad.length,
    imported: ok,
    rejected: rejected.length,
    errors: rejected.slice(0, 20),
  };
}

export default importRetentionCsv;


