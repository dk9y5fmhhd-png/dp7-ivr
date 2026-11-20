// =====================================================================
//  Daily deposit file import
//
//  Kya karta hai:
//    1. file parse (CSV ya XLSX)
//    2. har row ivr_deposits me (duplicate apne aap ignore)
//    3. username ke liye ivr_customers row banao/update karo
//    4. upload ka record deposit_uploads me
//
//  "Last deposit" hum calculate NAHI karte — view MAX() se nikalta hai.
//  Isliye ek user ke 5 deposit = 5 rows, aur call 5ve ke 7 din baad.
// =====================================================================
import { q, withTransaction } from '../lib/db.js';
import config from '../lib/config.js';
import log from '../lib/logger.js';
import { parseDepositFile } from './deposits.js';

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export async function importDepositFile(buffer, { filename = 'deposits.xlsx', isXlsx = false } = {}) {
  const { rows, bad, headers, headerRow } = parseDepositFile(buffer, { isXlsx });

  if (!rows.length) {
    const reason = bad[0]?.reason ?? 'koi valid row nahi mili';
    log.warn('deposits.import_no_rows', { filename, reason });
    await q(
      `INSERT INTO deposit_uploads (filename, rows_in, rows_bad, bad_reasons)
       VALUES ($1,$2,$3,$4)`,
      [filename, 0, bad.length, JSON.stringify(bad.slice(0, 20))],
    );
    return { ok: false, reason, headers, headerRow, imported: 0, duplicate: 0, rejected: bad.length, errors: bad.slice(0, 10) };
  }

  let inserted = 0;
  let duplicate = 0;
  const rejected = [...bad];
  let users = new Map();

  await withTransaction(async (client) => {
    // -----------------------------------------------------------------
    // 1. Customer rows — username ke hisaab se
    //    phone/name sirf tabhi update karo jab file me diya ho,
    //    warna purana data mat udo.
    // -----------------------------------------------------------------
    users = new Map();
    for (const r of rows) {
      const key = r.username;
      const prev = users.get(key) ?? { phone: null, name: null };
      users.set(key, {
        phone: r.phone ?? prev.phone,
        name: r.name ?? prev.name,
      });
    }

    for (const [username, u] of users) {
      await client.query(
        `INSERT INTO ivr_customers (customer_key, name, phone, source)
         VALUES ($1, $2, $3, 'deposit_upload')
         ON CONFLICT (customer_key) DO UPDATE SET
           name       = COALESCE(EXCLUDED.name, ivr_customers.name),
           phone      = COALESCE(EXCLUDED.phone, ivr_customers.phone),
           updated_at = now()`,
        [username, u.name ?? username, u.phone ?? null],
      );
    }

    // -----------------------------------------------------------------
    // 2. Deposits — bulk insert, duplicate chup-chaap skip
    // -----------------------------------------------------------------
    for (const part of chunk(rows, 500)) {
      const values = [];
      const params = [];
      part.forEach((r, i) => {
        const b = i * 6;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(
          r.username,
          r.deposit_at.toISOString(),
          r.amount_rupees,
          r.txn_ref,
          filename,
          JSON.stringify(r.raw ?? {}),
        );
      });

      const res = await client.query(
        `INSERT INTO ivr_deposits (username, deposit_at, amount_rupees, txn_ref, source_file, raw_row)
         VALUES ${values.join(',')}
         ON CONFLICT (lower(username), deposit_at, COALESCE(amount_rupees,0), COALESCE(txn_ref,''))
         DO NOTHING
         RETURNING id`,
        params,
      );
      inserted += res.rowCount;
      duplicate += part.length - res.rowCount;
    }
  });

  await q(
    `INSERT INTO deposit_uploads (filename, rows_in, rows_new, rows_dup, rows_bad, users_seen, bad_reasons)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [filename, rows.length + bad.length, inserted, duplicate, rejected.length, users.size, JSON.stringify(rejected.slice(0, 20))],
  );

  log.info('deposits.imported', {
    filename,
    rows: rows.length,
    inserted,
    duplicate,
    rejected: rejected.length,
    users: users.size,
  });

  // kitne users ka phone hi nahi — unko call nahi ja sakti
  const { rows: noPhone } = await q(
    `SELECT count(*)::int AS c FROM ivr_customers WHERE phone IS NULL OR normalize_phone(phone) IS NULL`,
  );

  return {
    ok: true,
    filename,
    headerRow,
    headers,
    rowsIn: rows.length + bad.length,
    imported: inserted,
    duplicate,
    rejected: rejected.length,
    usersSeen: users.size,
    usersWithoutPhone: noPhone[0].c,
    errors: rejected.slice(0, 10),
  };
}

export default importDepositFile;


