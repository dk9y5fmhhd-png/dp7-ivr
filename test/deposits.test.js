// =====================================================================
//  Deposits test — "ek username ke kai deposit" ka poora case
//  Chalao: node test/deposits.test.js
// =====================================================================
process.env.EXOTEL_MOCK = '1';
process.env.IVR_WEBHOOK_TOKEN = 'test-webhook-token';
process.env.IVR_ADMIN_TOKEN = 'test-admin-token';
process.env.DRY_RUN = 'false';
process.env.COMPANY_NAME = 'dp7';
process.env.MIN_DEPOSIT_RUPEES = '300';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8098';

import fs from 'node:fs/promises';
import path from 'node:path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0;
const fails = [];
const ok = (c, label, extra) => {
  if (c) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
};
const head = (s) => console.log(`\n${s}`);

const { pool, q } = await import('../src/lib/db.js');
const { importDepositFile } = await import('../src/retention/depositImport.js');
const { parseDepositFile } = await import('../src/retention/deposits.js');
const { isoWeekKey } = await import('../src/lib/cycle.js');
const worker = await import('../src/ivr/worker.js');
const { getSettings, updateSettings, clearSettingsCache } = await import('../src/settings.js');

// ---------------------------------------------------------------------
head('0. Schema');
for (const f of (await fs.readdir(path.join(root, 'db'))).filter((x) => x.endsWith('.sql')).sort()) {
  await pool.query(await fs.readFile(path.join(root, 'db', f), 'utf8'));
}
await q(
  `TRUNCATE call_events, call_jobs, ivr_customers, ivr_settings, ivr_deposits, deposit_uploads, retention_syncs
   RESTART IDENTITY CASCADE`,
);
await pool.query(await fs.readFile(path.join(root, 'db', '002_settings.sql'), 'utf8'));
await updateSettings({ call_window_start: '0', call_window_end: '24' });
clearSettingsCache();
ok(true, 'migration + settings ready');

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

// ---------------------------------------------------------------------
head('1. Deposit file parse — username + date + amount');
const csv = [
  'Username,Deposit Date,Amount,UTR',
  'rahul9,20/11/2026,5000,UTR001',
  'rahul9,10/11/2026,2000,UTR002',
  'rahul9,25/10/2026,1500,UTR003',
  'priya7,08/11/2026,3000,UTR004',
  'priya7,01/10/2026,1000,UTR005',
  'amit3,20/11/2026,700,UTR006',
].join('\n');

const parsedCsv = parseDepositFile(Buffer.from(csv), { isXlsx: false });
ok(parsedCsv.rows.length === 6, 'CSV ki 6 deposit rows padhi', parsedCsv.rows.length);
ok(parsedCsv.headerRow === 1, 'header row 1 pe mili', parsedCsv.headerRow);
ok(parsedCsv.rows.filter((r) => r.username === 'rahul9').length === 3, 'rahul9 ke 3 deposit');
ok(parsedCsv.rows[0].amount_rupees === 5000, 'amount parse hua', parsedCsv.rows[0].amount_rupees);
ok(parsedCsv.rows[0].txn_ref === 'UTR001', 'UTR parse hua', parsedCsv.rows[0].txn_ref);

head('1b. Wahi data XLSX me');
const ws = XLSX.utils.aoa_to_sheet([
  ['dp7 — Daily Deposit Report'],            // title row, header nahi
  ['Generated 20-11-2026'],
  [],
  ['Username', 'Deposit Date', 'Amount', 'UTR'],
  ['rahul9', new Date(2026, 10, 20, 14, 30), 5000, 'UTR001'],
  ['rahul9', new Date(2026, 10, 10, 11, 0), 2000, 'UTR002'],
  ['rahul9', new Date(2026, 9, 25, 9, 15), 1500, 'UTR003'],
  ['priya7', new Date(2026, 10, 8, 18, 45), 3000, 'UTR004'],
  ['priya7', new Date(2026, 9, 1, 12, 0), 1000, 'UTR005'],
  ['amit3', new Date(2026, 10, 20, 20, 10), 700, 'UTR006'],
]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Deposits');
const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

const parsedX = parseDepositFile(xlsxBuf, { isXlsx: true });
ok(parsedX.headerRow === 4, 'XLSX me title rows skip hui, header row 4 pe', parsedX.headerRow);
ok(parsedX.rows.length === 6, 'XLSX ki 6 deposit rows padhi', parsedX.rows.length);
ok(parsedX.rows.filter((r) => r.username === 'rahul9').length === 3, 'XLSX me bhi rahul9 ke 3');
ok(
  parsedX.rows[0].deposit_at instanceof Date && parsedX.rows[0].deposit_at.getDate() === 20,
  'XLSX ka asli date object padha (20)',
  parsedX.rows[0].deposit_at,
);

// ---------------------------------------------------------------------
head('2. Import — 3 deposit ek hi user ke');
const imp1 = await importDepositFile(xlsxBuf, { filename: '20-11-2026.xlsx', isXlsx: true });
ok(imp1.ok === true, 'import ok');
ok(imp1.imported === 6, '6 deposit insert hui', imp1.imported);
ok(imp1.usersSeen === 3, '3 unique username mile', imp1.usersSeen);
ok(imp1.usersWithoutPhone === 3, '3 users ka phone nahi (warning dikhi)', imp1.usersWithoutPhone);

const { rows: depCount } = await q('SELECT count(*)::int c FROM ivr_deposits');
ok(depCount[0].c === 6, 'DB me 6 deposit rows hain', depCount[0].c);

head('2b. Wahi file dobara upload — duplicate nahi');
const imp2 = await importDepositFile(xlsxBuf, { filename: '20-11-2026.xlsx', isXlsx: true });
ok(imp2.imported === 0, 'dobara upload pe 0 nayi row', imp2.imported);
ok(imp2.duplicate === 6, 'saari 6 duplicate detect hui', imp2.duplicate);
const { rows: depCount2 } = await q('SELECT count(*)::int c FROM ivr_deposits');
ok(depCount2[0].c === 6, 'row count wahi 6 raha', depCount2[0].c);

// upload ka record bhi bane — kitne naye, kitne duplicate
const { rows: upRec } = await q('SELECT rows_new, rows_dup FROM deposit_uploads ORDER BY id DESC LIMIT 1');
ok(upRec[0].rows_dup === 6, 'upload record me 6 duplicate likha', upRec[0].rows_dup);
ok(upRec[0].rows_new === 0, 'upload record me 0 naye', upRec[0].rows_new);

// ---------------------------------------------------------------------
head('3. View — last deposit = MAX, sabse aakhri wala');
const { rows: v } = await q(
  `SELECT customer_key, last_deposit_at, deposit_count, total_deposited_rupees
     FROM ivr_callable_customers ORDER BY customer_key`,
);
const rahul = v.find((r) => r.customer_key === 'rahul9');
ok(rahul.deposit_count === 3, 'rahul9 ke 3 deposit count hue', rahul.deposit_count);
ok(rahul.total_deposited_rupees === 8500, 'total 8500 (5000+2000+1500)', rahul.total_deposited_rupees);
ok(
  rahul.last_deposit_at.toISOString().startsWith('2026-11-20'),
  'last deposit 20 Nov hai (sabse aakhri, pehla nahi)',
  rahul.last_deposit_at,
);
const priya = v.find((r) => r.customer_key === 'priya7');
ok(priya.deposit_count === 2, 'priya7 ke 2 deposit');
ok(priya.last_deposit_at.toISOString().startsWith('2026-11-08'), 'priya7 ka last 8 Nov', priya.last_deposit_at);

// ---------------------------------------------------------------------
head('4. Asli scenario — 7 din ke hisaab se kaun call hona chahiye');
// Ab data ko "aaj" ke hisaab se set karte hain, taaki test kal bhi pass ho
await q('TRUNCATE ivr_deposits, call_jobs, deposit_uploads RESTART IDENTITY CASCADE');
await q('TRUNCATE ivr_customers RESTART IDENTITY CASCADE');

const scenario = [
  { user: 'user_today', deposits: [0], phone: '9812300001' },          // aaj deposit -> call NAHI
  { user: 'user_6din', deposits: [6], phone: '9812300002' },           // 6 din -> NAHI
  { user: 'user_8din', deposits: [8], phone: '9812300003' },           // 8 din -> HAAN
  { user: 'user_40din_2din', deposits: [40, 20, 2], phone: '9812300004' }, // 3 deposit, last 2 din -> NAHI
  { user: 'user_40din_12din', deposits: [40, 12], phone: '9812300005' },   // last 12 din -> HAAN
  { user: 'user_nodeposit', deposits: [], phone: '9812300006', created: 30 }, // kabhi deposit nahi -> HAAN
  { user: 'user_5din_nophone', deposits: [5], phone: null },           // 5 din + phone nahi -> NAHI
];

for (const s of scenario) {
  await q(
    `INSERT INTO ivr_customers (customer_key, name, phone, created_at, source)
     VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),'test')`,
    [s.user, s.user.toUpperCase(), s.phone, s.created ? daysAgo(s.created).toISOString() : null],
  );
  for (const d of s.deposits) {
    await q(`INSERT INTO ivr_deposits (username, deposit_at, amount_rupees) VALUES ($1,$2,$3)`, [
      s.user,
      daysAgo(d).toISOString(),
      300,
    ]);
  }
}

const created = await worker.buildCampaign(isoWeekKey());
const picked = created.map((r) => r.customer_key).sort();
ok(
  JSON.stringify(picked) === JSON.stringify(['user_40din_12din', 'user_8din', 'user_nodeposit']),
  'sirf 8 din, 12 din aur no-deposit wale chune gaye',
  picked,
);
ok(!picked.includes('user_today'), 'aaj deposit karne wala skip');
ok(!picked.includes('user_6din'), '6 din wala skip (7 chahiye)');
ok(!picked.includes('user_40din_2din'), '3 deposit hone par bhi last 2 din wala skip');
ok(!picked.includes('user_5din_nophone'), 'phone na hone wala skip');

head('4b. Aaj deposit aa gaya -> campaign se turant hat gaya');
await q(`INSERT INTO ivr_deposits (username, deposit_at, amount_rupees) VALUES ('user_8din', now(), 500)`);
await q('DELETE FROM call_jobs');
const created2 = await worker.buildCampaign(isoWeekKey());
const picked2 = created2.map((r) => r.customer_key).sort();
ok(!picked2.includes('user_8din'), 'deposit aate hi list se nikal gaya', picked2);
ok(picked2.length === 2, 'ab sirf 2 log bache', picked2.length);

// ---------------------------------------------------------------------
head('5. Dial + dry run — deposit count script me nahi jaata');
const dialed = await worker.dialQueue(10);
ok(dialed.length === 2, '2 call dial hui', dialed.length);

const { rows: jobs } = await q('SELECT * FROM call_jobs ORDER BY id');
ok(jobs.every((j) => j.status === 'calling'), 'jobs calling state me');
ok(jobs.every((j) => String(j.provider_call_sid).startsWith('MOCK-')), 'mock SID save');

// ---------------------------------------------------------------------
head('6. Admin: ek user ka deposit history');
const { rows: hist } = await q(
  `SELECT deposit_at FROM ivr_deposits WHERE lower(username)='user_40din_2din' ORDER BY deposit_at DESC`,
);
ok(hist.length === 3, 'history me 3 deposit', hist.length);
ok(
  Math.abs((Date.now() - hist[0].deposit_at.getTime()) / 86400000 - 2) < 0.1,
  'sabse upar wala 2 din purana hai (DESC order)',
);

// ---------------------------------------------------------------------
head('7. Galat file — saaf error, crash nahi');
const junk = await importDepositFile(Buffer.from('random,data\n1,2\n3,4'), { filename: 'junk.csv', isXlsx: false });
ok(junk.ok === false, 'header na hone pe ok=false');
ok(/username/.test(junk.reason), 'error message me "username" bataya', junk.reason);

const empty = await importDepositFile(Buffer.from(''), { filename: 'empty.csv', isXlsx: false });
ok(empty.ok === false, 'khaali file handle hui');

head('7b. Aadhi-adhuri rows — valid wale import, galat wale report');
const mix = [
  'username,date,amount',
  'good1,' + daysAgo(3).toISOString().slice(0, 10) + ',300',
  ',01/11/2026,300',                       // username khaali
  'bad-date,not-a-date,300',               // date galat
  'good2,02/11/2026,300',
].join('\n');
const mixRes = await importDepositFile(Buffer.from(mix), { filename: 'mix.csv', isXlsx: false });
ok(mixRes.imported === 2, '2 valid row import hui', mixRes.imported);
ok(mixRes.rejected === 2, '2 row reject hui', mixRes.rejected);
ok(mixRes.errors.some((e) => /username khaali/.test(e.reason)), 'username wala error report hua');
ok(mixRes.errors.some((e) => /date samajh nahi aayi/.test(e.reason)), 'date wala error report hua');

// ---------------------------------------------------------------------
head('8. Upload history');
const { rows: ups } = await q('SELECT filename, rows_new, rows_dup, rows_bad FROM deposit_uploads ORDER BY id DESC');
ok(ups.length === 3, 'teen import ka record (junk + empty + mix)', ups.length);
ok(ups.every((u) => u.rows_new !== null && u.rows_dup !== null), 'har record me counts bhare hain');
ok(ups.some((u) => u.rows_bad > 0), 'mix file me bad rows count hui', ups.map((u) => u.rows_bad));

// ---------------------------------------------------------------------
head('──────── RESULT ────────');
console.log(`  pass: ${pass}`);
console.log(`  fail: ${fails.length}`);
if (fails.length) {
  console.log('\n  Failed:');
  for (const f of fails) console.log(`   - ${f}`);
}

await pool.end();
process.exit(fails.length ? 1 : 0);






