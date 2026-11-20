// =====================================================================
//  End-to-end test — asli Postgres pe chalta hai, Exotel ki zaroorat nahi
//  Chalao: npm test
//
//  Kya check hota hai:
//   1. phone normalize, Hindi numbers, cycle key
//   2. campaign sirf eligible customers chunta hai
//   3. dialing (mock Exotel)
//   4. webhook: interested / no-answer / short-duration / duplicate
//   5. retry aur max-attempt cap
//   6. press 9 -> do_not_call
//   7. same hafte me double campaign nahi
//   8. HTTP: health, bad token 403, good webhook 200, admin jobs
// =====================================================================
process.env.EXOTEL_MOCK = process.env.EXOTEL_MOCK ?? '1';
process.env.IVR_WEBHOOK_TOKEN = process.env.IVR_WEBHOOK_TOKEN ?? 'test-webhook-token';
process.env.IVR_ADMIN_TOKEN = process.env.IVR_ADMIN_TOKEN ?? 'test-admin-token';
process.env.DRY_RUN = process.env.DRY_RUN ?? 'false';
process.env.COMPANY_NAME = process.env.COMPANY_NAME ?? 'DemoBrand';
process.env.MIN_DEPOSIT_RUPEES = process.env.MIN_DEPOSIT_RUPEES ?? '300';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:8099';

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}${extra ? ' → ' + JSON.stringify(extra) : ''}`);
  }
};
const head = (s) => console.log(`\n${s}`);

// env set hone ke BAAD import
const { pool, q } = await import('../src/lib/db.js');
const { normalizePhone } = await import('../src/lib/phone.js');
const { toHindiWords, rupeesToHindi } = await import('../src/lib/hindiNumbers.js');
const { isoWeekKey, daysSince } = await import('../src/lib/cycle.js');
const { parseDate, parseRetentionCsv } = await import('../src/retention/csv.js');
const worker = await import('../src/ivr/worker.js');
const { processStatusEvent } = await import('../src/ivr/router.js');
const script = await import('../src/ivr/script.js');
const config = (await import('../src/lib/config.js')).default;

// ---------------------------------------------------------------------
head('0. Schema');
for (const f of (await fs.readdir(path.join(root, 'db'))).filter((x) => x.endsWith('.sql')).sort()) {
  await pool.query(await fs.readFile(path.join(root, 'db', f), 'utf8'));
}
ok(true, 'migration chal gayi (db/*.sql)');

// saaf shuruaat
await q(
  `TRUNCATE call_events, call_jobs, ivr_customers, ivr_settings, ivr_deposits, deposit_uploads
   RESTART IDENTITY CASCADE`,
);
// settings defaults dobara bharo (002 file)
await pool.query(await fs.readFile(path.join(root, 'db', '002_settings.sql'), 'utf8'));

// Test din-raat pe depend na kare — window poori khol do.
// Asli window ka test 14 section me fixed ghadi pe hota hai.
await q(`UPDATE ivr_settings SET value='0'  WHERE key='call_window_start'`);
await q(`UPDATE ivr_settings SET value='24' WHERE key='call_window_end'`);

// ---------------------------------------------------------------------
head('1. Pure functions');
ok(normalizePhone('9876543210') === '+919876543210', 'normalize 10 digit');
ok(normalizePhone('09876543210') === '+919876543210', 'normalize 0-prefixed');
ok(normalizePhone('+91-98765-43210') === '+919876543210', 'normalize with dashes');
ok(normalizePhone('919876543210') === '+919876543210', 'normalize with 91');
ok(normalizePhone('12345') === null, 'invalid phone -> null');
ok(toHindiWords(300) === 'तीन सौ', 'hindi 300', toHindiWords(300));
ok(rupeesToHindi(300) === 'तीन सौ रुपये', 'rupees 300', rupeesToHindi(300));
ok(toHindiWords(7) === 'सात', 'hindi 7');
ok(toHindiWords(5000) === 'पाँच हज़ार', 'hindi 5000', toHindiWords(5000));
ok(/^\d{4}-W\d{2}$/.test(isoWeekKey()), 'iso week key format', isoWeekKey());
ok(parseDate('15/08/2026')?.toISOString().startsWith('2026-08-15'), 'date DD/MM/YYYY');
ok(daysSince(new Date(Date.now() - 8 * 86400000).toISOString()) === 8, 'daysSince 8');

const preview = script.buildCallScript({ name: 'Rahul Sharma', attempt: 1, min_deposit_rupees: 300 }, {
  company: 'DemoBrand',
  supportNumber: '9876500000',
});
ok(preview.text.includes('तीन सौ रुपये'), 'script me amount Hindi me');
ok(!/[0-9]/.test(preview.text), 'script me koi digit nahi (TTS English na bole)');
ok(preview.text.includes('Rahul'), 'script me customer ka naam (Latin fallback)');
ok(/यह कॉल आपके खाते/.test(preview.text), 'script me opening line hai');

const previewHi = script.buildCallScript(
  { name: 'Priya Verma', name_hi: 'प्रिया वर्मा', attempt: 1, min_deposit_rupees: 300 },
  { company: 'DemoBrand' },
);
ok(previewHi.text.includes('प्रिया'), 'name_hi hone pe Devanagari naam use hota hai');

// ---------------------------------------------------------------------
head('2. Retention CSV import');
const csv = [
  'client_id,client_name,mobile_no,last_deposit_date,min_deposit,status',
  'C-2001,Sunil Mehta,9812300001,01/01/2026,300,ACTIVE',
  'C-2002,Anita Desai,9812300002,15/08/2026,500,ACTIVE',
  'C-2003,Bad Phone,12345,15/08/2026,300,ACTIVE',
].join('\n');
const parsed = parseRetentionCsv(csv);
ok(parsed.rows.length === 3, 'csv ne 3 rows padhi', parsed.rows.length);
ok(parsed.rows[0].min_deposit_rupees === 300, 'csv se min deposit 300');
const { importRetentionCsv } = await import('../src/retention/import.js');
const imp = await importRetentionCsv(csv, { filename: 'test.csv' });
ok(imp.imported === 2, '2 row import hui', imp);
ok(imp.rejected === 1, '1 row reject hui (invalid phone)', imp.rejected);

// ---------------------------------------------------------------------
head('3. Campaign — sirf eligible customers');
const { seedDemo } = await import('../scripts/seed-demo.js');
await seedDemo();
const created = await worker.buildCampaign(isoWeekKey());
const keys = created.map((r) => r.customer_key).sort();
// C-2001/C-2002 retention CSV se aaye — matlab import ka data calling me pahuncha
ok(
  JSON.stringify(keys) === JSON.stringify(['C-1001', 'C-1002', 'C-1008', 'C-2001', 'C-2002']),
  'sirf eligible customers chune gaye (seed + imported)',
  keys,
);
ok(!keys.includes('C-1003'), '5 din pehle deposit wala skip');
ok(!keys.includes('C-1004'), 'inactive skip');
ok(!keys.includes('C-1005'), 'DNC skip');
ok(!keys.includes('C-1006'), 'invalid phone skip');
ok(!keys.includes('C-1007'), '7 din se kam (6 din 23 ghante) wala skip');

// ---------------------------------------------------------------------
head('4. Dedupe — dobara campaign me 0 nayi job');
const again = await worker.buildCampaign(isoWeekKey());
ok(again.length === 0, 'same hafte me dobara koi job nahi bani', again.length);

// ---------------------------------------------------------------------
head('5. Dialing (mock Exotel)');
const dialed = await worker.dialQueue(10);
ok(dialed.length === 5, '5 call dial hui', dialed.length);
const { rows: jobs } = await q('SELECT * FROM call_jobs ORDER BY id');
ok(jobs.every((j) => j.status === 'calling'), 'saari jobs calling state me');
ok(jobs.every((j) => String(j.provider_call_sid).startsWith('MOCK-')), 'mock SID save hua');

const jobBy = (k) => jobs.find((j) => j.customer_key === k);

// ---------------------------------------------------------------------
head('6. Webhook — interested (press 1, 42 sec)');
await processStatusEvent(
  { CallSid: jobBy('C-1001').provider_call_sid, Status: 'completed', Duration: '42', Digits: '1', CustomField: String(jobBy('C-1001').id) },
  { CallSid: jobBy('C-1001').provider_call_sid, Status: 'completed', Duration: '42', Digits: '1' },
);
let row = (await q('SELECT * FROM call_jobs WHERE id=$1', [jobBy('C-1001').id])).rows[0];
ok(row.status === 'completed', 'status completed', row.status);
ok(row.disposition === 'interested', 'disposition interested', row.disposition);
ok(row.duration_sec === 42, 'duration 42 sec save', row.duration_sec);

head('6b. Duplicate webhook ignore');
await processStatusEvent(
  { CallSid: jobBy('C-1001').provider_call_sid, Status: 'completed', Duration: '42', Digits: '1' },
  { CallSid: jobBy('C-1001').provider_call_sid, Status: 'completed', Duration: '42' },
);
const evCount = (await q(`SELECT count(*)::int c FROM call_events WHERE job_id=$1 AND kind='status'`, [jobBy('C-1001').id])).rows[0].c;
ok(evCount === 1, 'duplicate event sirf ek baar save hua', evCount);

head('6c. No-answer -> retry schedule');
await processStatusEvent(
  { CallSid: jobBy('C-1002').provider_call_sid, Status: 'no-answer', Duration: '0' },
  { CallSid: jobBy('C-1002').provider_call_sid, Status: 'no-answer' },
);
row = (await q('SELECT * FROM call_jobs WHERE id=$1', [jobBy('C-1002').id])).rows[0];
ok(row.status === 'no_answer', 'status no_answer', row.status);
ok(row.next_attempt_at !== null, 'next_attempt_at set hua');

head('6d. 3 sec call = asal me baat nahi hui');
await processStatusEvent(
  { CallSid: jobBy('C-1008').provider_call_sid, Status: 'completed', Duration: '3' },
  { CallSid: jobBy('C-1008').provider_call_sid, Status: 'completed', Duration: '3' },
);
row = (await q('SELECT * FROM call_jobs WHERE id=$1', [jobBy('C-1008').id])).rows[0];
ok(row.status === 'no_answer', '3 sec call -> no_answer treat hui', row.status);

// ---------------------------------------------------------------------
head('7. Retry — attempt 2, phir cap');
await q(`UPDATE call_jobs SET next_attempt_at = now() - interval '1 hour' WHERE status='no_answer'`);
const retries = await worker.scheduleRetries();
ok(retries.length === 2, '2 retry queue me aayi', retries.length);
row = (await q('SELECT * FROM call_jobs WHERE id=$1', [jobBy('C-1002').id])).rows[0];
ok(row.attempt === 2 && row.status === 'pending', 'attempt 2, status pending', row);

// attempt 3 tak pahuncha do, phir no_answer -> aur retry nahi
await q(`UPDATE call_jobs SET attempt=3, status='no_answer', next_attempt_at=now() - interval '1 hour' WHERE id=$1`, [
  jobBy('C-1002').id,
]);
const capRetries = await worker.scheduleRetries();
ok(capRetries.length === 0, 'max attempt ke baad retry nahi (attempt 3/3)', capRetries.length);

// ---------------------------------------------------------------------
head('8. Press 9 -> do_not_call');
const realJob = jobBy('C-1008');
await processStatusEvent(
  { CallSid: realJob.provider_call_sid, Status: 'completed', Duration: '25', Digits: '9' },
  { CallSid: realJob.provider_call_sid, Status: 'completed', Duration: '25', Digits: '9' },
);
row = (await q('SELECT * FROM call_jobs WHERE id=$1', [realJob.id])).rows[0];
ok(row.disposition === 'opted_out', 'disposition opted_out', row.disposition);
const cust = (await q('SELECT * FROM ivr_customers WHERE customer_key=$1', [realJob.customer_key])).rows[0];
ok(cust.do_not_call === true, 'customer pe do_not_call true');

// ab campaign me dobara nahi aana chahiye (agla hafta bhi)
const nextWeek = isoWeekKey(new Date(Date.now() + 7 * 86400000));
const nextWeekCreated = await worker.buildCampaign(nextWeek);
ok(!nextWeekCreated.some((c) => c.customer_key === realJob.customer_key), 'opted-out customer agle hafte bhi skip');

// ---------------------------------------------------------------------
head('9. Dry run — koi call nahi jaati');
const { rows: before } = await q(`SELECT count(*)::int c FROM call_jobs WHERE status='calling'`);
const cfg = (await import('../src/lib/config.js')).default;
cfg.dryRun = true;
await q(`UPDATE call_jobs SET status='pending' WHERE status='no_answer'`);
const dryRes = await worker.dialQueue(5);
cfg.dryRun = false;
ok(dryRes.every((r) => r.outcome === 'dry_run'), 'dry run me koi asli call nahi', dryRes);

// ---------------------------------------------------------------------
head('10. HTTP — health, token, admin');
const port = 8099;
const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server start nahi hua')), 15000);
  child.stdout.on('data', (b) => {
    if (b.toString().includes('server.started')) {
      clearTimeout(t);
      resolve();
    }
  });
  child.stderr.on('data', (b) => process.env.DEBUG && console.error(b.toString()));
});

const base = `http://127.0.0.1:${port}`;
try {
  const h = await fetch(`${base}/api/health`);
  ok(h.status === 200, 'GET /api/health -> 200');

  const bad = await fetch(`${base}/api/ivr/webhook?token=galat`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'CallSid=x&Status=completed',
  });
  ok(bad.status === 403, 'galat token -> 403', bad.status);

  const noAuth = await fetch(`${base}/api/ivr/jobs`);
  ok(noAuth.status === 401, 'bina admin token -> 401', noAuth.status);

  const jobsRes = await fetch(`${base}/api/ivr/jobs?limit=5`, { headers: { 'x-admin-token': 'test-admin-token' } });
  const jobsJson = await jobsRes.json();
  ok(jobsRes.status === 200 && Array.isArray(jobsJson.jobs), 'admin /jobs -> 200 + list');

  const stats = await fetch(`${base}/api/ivr/stats`, { headers: { 'x-admin-token': 'test-admin-token' } });
  const statsJson = await stats.json();
  ok(stats.status === 200 && statsJson.jobs.completed >= 1, 'admin /stats -> counts', statsJson.jobs);

  const prev = await fetch(`${base}/api/ivr/preview?customer_key=C-1001`, {
    headers: { 'x-admin-token': 'test-admin-token' },
  });
  const prevJson = await prev.json();
  ok(prev.status === 200 && prevJson.text?.includes('तीन सौ'), 'script preview Hindi me', prevJson.block);

  // webhook good token — 200 turant milta hai
  const good = await fetch(`${base}/api/ivr/webhook?token=test-webhook-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'CallSid=MOCK-HTTPTEST&Status=completed&Duration=30&CustomField=1',
  });
  ok(good.status === 200, 'sahi token -> 200 turant', good.status);

  // webhook 200 turant deta hai, processing uske baad — server ko kaam karne do
  await new Promise((r) => setTimeout(r, 800));

  // -------------------------------------------------------------------
  head('10b. Settings — agent number yahan se badalta hai');

  const s0 = await fetch(`${base}/api/ivr/settings`, { headers: { 'x-admin-token': 'test-admin-token' } });
  const s0j = await s0.json();
  ok(s0.status === 200 && s0j.settings.companyName === 'dp7', 'default company dp7 hai', s0j.settings.companyName);
  ok(s0j.settings.agentNumber === '+919000000001', 'default agent placeholder', s0j.settings.agentNumber);

  const noTok = await fetch(`${base}/api/ivr/settings`);
  ok(noTok.status === 401, 'bina token settings -> 401');

  // naya agent number, bina +91 ke — normalize hona chahiye
  const put = await fetch(`${base}/api/ivr/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
    body: JSON.stringify({ agent_number: '9876500099', min_deposit_rupees: '300' }),
  });
  const putj = await put.json();
  ok(put.status === 200 && putj.applied.agent_number === '+919876500099', 'agent number save + normalize', putj.applied);

  const s1 = await (await fetch(`${base}/api/ivr/settings`, { headers: { 'x-admin-token': 'test-admin-token' } })).json();
  ok(s1.settings.agentNumber === '+919876500099', 'naya number padha ja raha hai', s1.settings.agentNumber);

  // galat number reject
  const badPut = await fetch(`${base}/api/ivr/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
    body: JSON.stringify({ agent_number: '123' }),
  });
  ok(badPut.status === 400, 'galat number reject hua', badPut.status);

  // agent endpoint
  const ag = await fetch(`${base}/api/ivr/agent?token=test-admin-token`);
  const agj = await ag.json();
  ok(ag.status === 200 && agj.agent_number === '+919876500099', 'GET /agent naya number deta hai', agj);

  // company naam badla -> script me turant dikhna chahiye
  await fetch(`${base}/api/ivr/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
    body: JSON.stringify({ company_name: 'dp7' }),
  });
  const prev2 = await (
    await fetch(`${base}/api/ivr/preview?customer_key=C-1001&attempt=1`, {
      headers: { 'x-admin-token': 'test-admin-token' },
    })
  ).json();
  ok(prev2.text.includes('dp7'), 'script me company dp7 bolti hai');
  ok(prev2.text.includes('तीन सौ'), 'script me ₹300 Hindi me');

  // settings page khulta hai
  const page = await fetch(`${base}/ivr/settings`);
  const html = await page.text();
  ok(page.status === 200 && html.includes('agent_number'), 'settings page serve ho raha hai');

  // settings badalne ka asar worker pe
  const { getSettings, clearSettingsCache } = await import('../src/settings.js');
  clearSettingsCache();
  const ws = await getSettings({ fresh: true });
  ok(ws.agentNumber === '+919876500099' && ws.minDepositRupees === 300, 'worker ko nayi settings milti hain', ws.agentNumber);
} finally {
  child.kill('SIGKILL');
}

// ---------------------------------------------------------------------
await new Promise((r) => setTimeout(r, 300));
head('11. DB me raw payload save hua?');
const raw = (await q(`SELECT payload->>'Status' s FROM call_events WHERE kind='status' LIMIT 1`)).rows[0];
ok(Boolean(raw?.s), 'call_events me raw payload hai', raw);

const evTotal = (await q('SELECT count(*)::int c FROM call_events')).rows[0].c;
ok(evTotal >= 4, 'saare events log hue', evTotal);

// ---------------------------------------------------------------------
head('12. Cron matcher (Asia/Kolkata)');
ok(worker.cronMatches('30 21 * * *', new Date('2026-11-20T16:00:00Z'), 'Asia/Kolkata'), '21:30 IST -> match');
ok(!worker.cronMatches('30 21 * * *', new Date('2026-11-20T10:00:00Z'), 'Asia/Kolkata'), '15:30 IST -> no match');
ok(worker.cronMatches('*/5 * * * *', new Date('2026-11-20T10:05:00Z'), 'UTC'), '*/5 minute match');

head('13. Advisory lock — do worker ek saath nahi chalenge');
const c1 = await pool.connect();
const l1 = (await c1.query('SELECT pg_try_advisory_lock($1) AS ok', [config.advisorLockId])).rows[0].ok;
const c2 = await pool.connect();
const l2 = (await c2.query('SELECT pg_try_advisory_lock($1) AS ok', [config.advisorLockId])).rows[0].ok;
ok(l1 === true, 'pehla worker lock le paya');
ok(l2 === false, 'doosra worker lock nahi le paya (double call nahi hogi)');
await c2.query('SELECT pg_advisory_unlock_all()');
c2.release();
await c1.query('SELECT pg_advisory_unlock_all()');
c1.release();

head('14. Call window (IST) — raat 10 baje ke baad call nahi');
const { withinCallWindow, clearSettingsCache: clearCache2, updateSettings } = await import('../src/settings.js');
const s = { callWindowStart: 10, callWindowEnd: 21 };
ok(withinCallWindow(s, new Date('2026-11-20T05:30:00Z')), '11:00 IST -> andar hai');   // 05:30Z = 11:00 IST
ok(!withinCallWindow(s, new Date('2026-11-20T03:30:00Z')), '09:00 IST -> bahar hai');
ok(!withinCallWindow(s, new Date('2026-11-20T18:00:00Z')), '23:30 IST -> bahar hai');

// settings API se window band karo -> worker turant maan le
await updateSettings({ call_window_start: '21', call_window_end: '22' });
clearCache2();
const blocked = await worker.dialQueue(5);
ok(blocked.length === 0, 'window band hone pe koi call nahi jaati', blocked.length);
await updateSettings({ call_window_start: '0', call_window_end: '24' });
clearCache2();

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












