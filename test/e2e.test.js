// =====================================================================
//  Full end-to-end test — DP7 jaisa public.deposits banake, asli Postgres pe
//  Chalao: npm test
//
//  Kya check hota hai:
//   1. migration (auto) + view public.deposits pe
//   2. ek username ke kai deposit → MAX(play_date) se last deposit
//   3. 7 din ka gate (aaj / 6 din / 8 din / 3 deposit wale)
//   4. campaign + dialing (mock Exotel) + advisory lock
//   5. DTMF 1 (link) / 2 (naya ID) / 3 (agent) / 9 (DND) — DB + outbox
//   6. webhook: duplicate ignore, no-answer retry, 3 sec call
//   7. settings (agent number) + call window
//   8. HTTP: health, setup, tokens, settings page
// =====================================================================
process.env.EXOTEL_MOCK = '1';
process.env.IVR_WEBHOOK_TOKEN = 'test-webhook-token';
process.env.IVR_ADMIN_TOKEN = 'test-admin-token';
process.env.DRY_RUN = 'false';
process.env.COMPANY_NAME = 'dp7';
process.env.MIN_DEPOSIT_RUPEES = '300';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8097';

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
const autoMigrate = (await import('../src/lib/autoMigrate.js')).default;
const { normalizePhone } = await import('../src/lib/phone.js');
const { toHindiWords, rupeesToHindi } = await import('../src/lib/hindiNumbers.js');
const { isoWeekKey } = await import('../src/lib/cycle.js');
const worker = await import('../src/ivr/worker.js');
const { applyDigit, generateId } = await import('../src/ivr/dtmf.js');
const scripts = await import('../src/ivr/script.js');
const { processStatusEvent } = await import('../src/ivr/router.js');
const { getSettings, updateSettings, clearSettingsCache, withinCallWindow } = await import('../src/settings.js');
const config = (await import('../src/lib/config.js')).default;

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

// DP7 ka play_date IST ka din hai — test bhi IST se hisaab kare,
// warna 6 din wala din UTC me 7 din ban jaata hai
const istDaysAgo = (n) => {
  const d = new Date(Date.now() + 5.5 * 3600000);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(base - n * 86400000).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------
head('0. DP7 jaisa public.deposits banao + migration chalao');
await pool.query(`
  CREATE TABLE IF NOT EXISTS public.deposits (
    id        bigserial PRIMARY KEY,
    username  text,
    mobile    text,
    play_date date,
    amount    numeric
  )
`);
const { applied, failed } = await autoMigrate();
ok(failed.length === 0, 'saari migration chali gayi', failed);
ok(applied.length >= 5, '5+ migration files apply hui', applied.length);

// ab saaf shuruaat
await q(`TRUNCATE public.deposits RESTART IDENTITY`);
await q(
  `TRUNCATE call_events, call_jobs, ivr_customers, ivr_settings, ivr_deposits, ivr_messages, deposit_uploads
   RESTART IDENTITY CASCADE`,
);

// settings defaults + test ke liye window poori kholo
await pool.query(await fs.readFile(path.join(root, 'db', '002_settings.sql'), 'utf8'));
await updateSettings({ call_window_start: '0', call_window_end: '24' });
clearSettingsCache();

const viewSql = (await q(`SELECT pg_get_viewdef('ivr_callable_customers'::regclass) AS d`)).rows[0].d;
// pg_get_viewdef public schema ko chhod deta hai — dono shapes chalti hain
ok(/from\s+(public\.)?deposits/i.test(viewSql), 'view ab public.deposits pe point karta hai', viewSql.slice(0, 120));

// ---------------------------------------------------------------------
head('1. Pure functions');
ok(normalizePhone('7307130488') === '+917307130488', 'normalize 10 digit');
ok(normalizePhone('07307130488') === '+917307130488', 'normalize 0-prefixed');
ok(normalizePhone('+91-73071-30488') === '+917307130488', 'normalize dashes');
ok(normalizePhone('12345') === null, 'invalid phone -> null');
ok(toHindiWords(300) === 'तीन सौ', 'hindi 300');
ok(rupeesToHindi(300) === 'तीन सौ रुपये', 'rupees 300');
ok(toHindiWords(5000) === 'पाँच हज़ार', 'hindi 5000', toHindiWords(5000));
ok(/^\d{4}-W\d{2}$/.test(isoWeekKey()), 'iso week key');

// ---------------------------------------------------------------------
head('2. Deposits — ek username ke kai deposit');
const DEP = [
  // 10babita10: 3 deposit, sabse aakhri 8 din purana -> call HAAN
  ['10babita10', '7307130488', 40, 500],
  ['10babita10', '7307130488', 20, 300],
  ['10babita10', '7307130488', 8, 1000],
  // rahul9: aaj deposit -> call NAHI
  ['rahul9', '9812345001', 30, 500],
  ['rahul9', '9812345001', 0, 300],
  // priya7: 6 din -> NAHI
  ['priya7', '9812345002', 6, 700],
  // amit3: 15 din -> HAAN
  ['amit3', '9812345003', 15, 400],
  // sunil1: sirf purana deposit 25 din -> HAAN
  ['sunil1', '9812345004', 25, 300],
  // bad phone -> skip
  ['kachra1', '12345', 12, 300],
];

for (const [u, m, d, a] of DEP) {
  await q(`INSERT INTO public.deposits (username, mobile, play_date, amount) VALUES ($1,$2,$3,$4)`, [
    u, m, istDaysAgo(d), a,
  ]);
}

const { rows: v } = await q(`SELECT * FROM ivr_callable_customers ORDER BY customer_key`);
ok(v.length === 6, 'view me 6 unique users', v.length);

const babita = v.find((r) => r.customer_key === '10babita10');
ok(babita.deposit_count === 3, '10babita10 ke 3 deposit count', babita.deposit_count);
ok(Number(babita.total_deposited_rupees) === 1800, 'total 1800', babita.total_deposited_rupees);
ok(
  Math.abs((Date.now() - new Date(babita.last_deposit_at).getTime()) / 86400000 - 8) < 1.1,
  'last deposit 8 din purana (sabse aakhri, pehla nahi)',
  babita.last_deposit_at,
);
ok(babita.phone_e164 === '+917307130488', 'phone normalize hua', babita.phone_e164);
ok(v.every((r) => r.is_active === true), 'is_active true (DP7 Inactive != account band)');

head('2b. trigger — naya deposit aaye to ivr_customers row bane');
await q(`INSERT INTO public.deposits (username, mobile, play_date, amount) VALUES ('naya_user','9812349999',now()::date,300)`);
const { rows: cRow } = await q(`SELECT * FROM ivr_customers WHERE customer_key='naya_user'`);
ok(cRow.length === 1, 'naye user ki ivr_customers row ban gayi');
await q(`DELETE FROM public.deposits WHERE username='naya_user'`);
await q(`DELETE FROM ivr_customers WHERE customer_key='naya_user'`);

// ---------------------------------------------------------------------
head('3. Campaign — sirf 7+ din wale');
const created = await worker.buildCampaign(isoWeekKey());
const picked = created.map((r) => r.customer_key).sort();
ok(JSON.stringify(picked) === JSON.stringify(['10babita10', 'amit3', 'sunil1']), 'sirf 3 eligible chune', picked);
ok(!picked.includes('rahul9'), 'aaj deposit wala skip');
ok(!picked.includes('priya7'), '6 din wala skip');
ok(!picked.includes('kachra1'), 'bad phone wala skip');
ok(!picked.includes('naya_user'), 'deleted user skip');

head('3b. Dedupe — dobara campaign me 0');
const again = await worker.buildCampaign(isoWeekKey());
ok(again.length === 0, 'same hafte me dobara job nahi', again.length);

// ---------------------------------------------------------------------
head('4. Dialing (mock) + advisory lock');
const dialed = await worker.dialQueue(10);
ok(dialed.length === 3, '3 call dial hui', dialed.length);

const { rows: jobs } = await q(`SELECT * FROM call_jobs ORDER BY id`);
ok(jobs.every((j) => j.status === 'calling'), 'saari jobs calling');
ok(jobs.every((j) => String(j.provider_call_sid).startsWith('MOCK-')), 'mock SID save');
const jobBy = (k) => jobs.find((j) => j.customer_key === k);

const c1 = await pool.connect();
const c2 = await pool.connect();
const l1 = (await c1.query('SELECT pg_try_advisory_lock($1) AS ok', [config.advisorLockId])).rows[0].ok;
const l2 = (await c2.query('SELECT pg_try_advisory_lock($1) AS ok', [config.advisorLockId])).rows[0].ok;
ok(l1 === true && l2 === false, 'doosra worker lock nahi le paya (double call nahi)');
await c2.query('SELECT pg_advisory_unlock_all()'); c2.release();
await c1.query('SELECT pg_advisory_unlock_all()'); c1.release();

// ---------------------------------------------------------------------
head('5. DTMF 1 — website link WhatsApp + SMS me queue');
let r = await applyDigit(jobBy('10babita10'), '1');
ok(r.action === 'send_link' && r.disposition === 'link_sent', 'action send_link', r);
let { rows: msgs } = await q(`SELECT channel, template FROM ivr_messages WHERE customer_key='10babita10' ORDER BY channel`);
ok(msgs.length === 2, '2 message queue me (whatsapp + sms)', msgs);
ok(msgs.map((m) => m.channel).sort().join(',') === 'sms,whatsapp', 'dono channel', msgs.map((m) => m.channel));

head('5b. duplicate — dobara 1 dabaya to naya message nahi');
await applyDigit(jobBy('10babita10'), '1');
({ rows: msgs } = await q(`SELECT id FROM ivr_messages WHERE customer_key='10babita10'`));
ok(msgs.length === 2, 'duplicate message nahi bana', msgs.length);

head('5c. DTMF 2 — naya ID');
r = await applyDigit(jobBy('amit3'), '2');
ok(r.action === 'new_id' && r.disposition === 'id_created', 'action new_id', r);
ok(/^amit3\d{4}$/.test(r.text ?? ''), 'ID format sahi (amit3XXXX)', r.text);
const { rows: idRow } = await q(`SELECT new_id FROM call_jobs WHERE customer_key='amit3'`);
ok(idRow[0].new_id === r.text, 'naya ID call_jobs me save');
({ rows: msgs } = await q(`SELECT template FROM ivr_messages WHERE customer_key='amit3'`));
ok(msgs.length === 2 && msgs.every((m) => m.template === 'new_id'), 'ID message 2 channel pe queue', msgs);

head('5d. DTMF 3 — agent transfer');
r = await applyDigit(jobBy('sunil1'), '3');
ok(r.action === 'agent' && r.disposition === 'interested', 'action agent', r);

head('5e. DTMF 9 — DND');
await q(`INSERT INTO public.deposits (username, mobile, play_date, amount) VALUES ('dnc_user','9812347777','${istDaysAgo(20)}',300)`);
const { rows: dncJob } = await q(
  `INSERT INTO call_jobs (customer_key, name, phone, reason, cycle_key, attempt, status)
   VALUES ('dnc_user','dnc_user','+919812347777','no_deposit_7d','TEST-DNC',1,'calling') RETURNING *`,
);
r = await applyDigit(dncJob[0], '9');
ok(r.action === 'opt_out' && r.disposition === 'opted_out', 'action opt_out', r);
const { rows: dncCust } = await q(`SELECT do_not_call FROM ivr_customers WHERE customer_key='dnc_user'`);
ok(dncCust[0].do_not_call === true, 'customer DND flag set');

head('5f. DND ke baad campaign me nahi aayega');
const nextWeek = isoWeekKey(new Date(Date.now() + 7 * 86400000));
const nw = await worker.buildCampaign(nextWeek);
ok(!nw.some((x) => x.customer_key === 'dnc_user'), 'DND user agle hafte bhi skip');
await q(`DELETE FROM call_jobs WHERE cycle_key='TEST-DNC'`);

// ---------------------------------------------------------------------
head('6. Webhook — duplicate / no-answer / 3 sec');
await processStatusEvent(
  { CallSid: jobBy('sunil1').provider_call_sid, Status: 'completed', Duration: '42', Digits: '3' },
  { CallSid: jobBy('sunil1').provider_call_sid, Status: 'completed', Duration: '42', Digits: '3' },
);
let job = (await q(`SELECT * FROM call_jobs WHERE id=$1`, [jobBy('sunil1').id])).rows[0];
ok(job.duration_sec === 42, 'duration 42 save', job.duration_sec);

await processStatusEvent(
  { CallSid: jobBy('sunil1').provider_call_sid, Status: 'completed', Duration: '42', Digits: '3' },
  { CallSid: jobBy('sunil1').provider_call_sid, Status: 'completed', Duration: '42' },
);
const evCount = (await q(`SELECT count(*)::int c FROM call_events WHERE job_id=$1 AND kind='status'`, [jobBy('sunil1').id])).rows[0].c;
ok(evCount === 1, 'duplicate webhook sirf ek baar save', evCount);

await processStatusEvent(
  { CallSid: jobBy('amit3').provider_call_sid, Status: 'no-answer', Duration: '0' },
  { CallSid: jobBy('amit3').provider_call_sid, Status: 'no-answer' },
);
job = (await q(`SELECT * FROM call_jobs WHERE id=$1`, [jobBy('amit3').id])).rows[0];
ok(job.status === 'no_answer' && job.next_attempt_at !== null, 'no_answer + retry set', job.status);

head('6b. 3 sec call = baat nahi hui');
await q(`INSERT INTO public.deposits (username, mobile, play_date, amount) VALUES ('short_user','9812346666','${istDaysAgo(20)}',300)`);
const { rows: sj } = await q(
  `INSERT INTO call_jobs (customer_key, name, phone, reason, cycle_key, attempt, status, provider_call_sid)
   VALUES ('short_user','short_user','+919812346666','no_deposit_7d','TEST-SHORT',1,'calling','MOCK-SHORT') RETURNING *`,
);
await processStatusEvent({ CallSid: 'MOCK-SHORT', Status: 'completed', Duration: '3' }, { CallSid: 'MOCK-SHORT', Status: 'completed', Duration: '3' });
job = (await q(`SELECT * FROM call_jobs WHERE id=$1`, [sj[0].id])).rows[0];
ok(job.status === 'no_answer', '3 sec call -> no_answer', job.status);

head('6c. retry cap');
await q(`UPDATE call_jobs SET attempt=3, status='no_answer', next_attempt_at=now() - interval '1 hour'
         WHERE status IN ('no_answer','busy','failed')`);
const capRetries = await worker.scheduleRetries();
ok(capRetries.length === 0, 'attempt 3/3 ke baad retry nahi', capRetries.length);

// ---------------------------------------------------------------------
head('7. Settings — agent number bina redeploy');
const s0 = await getSettings({ fresh: true });
ok(s0.companyName === 'dp7', 'company dp7', s0.companyName);
ok(s0.minDepositRupees === 300, 'min deposit 300', s0.minDepositRupees);
ok(s0.noDepositDays === 7, 'no deposit days 7', s0.noDepositDays);

await updateSettings({ agent_number: '9876500099' });
clearSettingsCache();
const s1 = await getSettings({ fresh: true });
ok(s1.agentNumber === '+919876500099', 'agent number normalize + save', s1.agentNumber);

const bad = await updateSettings({ agent_number: '123' });
ok(bad.errors.length > 0 && !bad.applied.agent_number, 'galat number reject', bad.errors);

head('7b. call window (IST)');
const w = { callWindowStart: 10, callWindowEnd: 21 };
ok(withinCallWindow(w, new Date('2026-11-20T05:30:00Z')), '11:00 IST andar');
ok(!withinCallWindow(w, new Date('2026-11-20T18:00:00Z')), '23:30 IST bahar');

await updateSettings({ call_window_start: '21', call_window_end: '22' });
clearSettingsCache();
ok((await worker.dialQueue(5)).length === 0, 'window band pe koi call nahi');
await updateSettings({ call_window_start: '0', call_window_end: '24' });
clearSettingsCache();

// ---------------------------------------------------------------------
head('8. Script — Hindi, koi digit nahi');
await updateSettings({ company_name: 'dp7' });
clearSettingsCache();
const sc = scripts.buildCallScript({ name: '10babita10', attempt: 1, min_deposit_rupees: 300 }, { company: 'dp7' });
ok(sc.text.includes('तीन सौ रुपये'), 'amount Hindi me');
// amount aur din shabdon me hone chahiye (naam/company me digit ho sakta hai)
ok(/सात दिनों/.test(sc.text), 'din Hindi me (सात दिनों)');
ok(sc.text.includes('dp7'), 'company naam');
ok(sc.text.includes('वेबसाइट'), 'menu me website option');
ok(sc.text.includes('आई डी'), 'menu me naya ID option');
const menuTxt = scripts.menu();
ok(!/[0-9]/.test(menuTxt), 'menu me bhi digit nahi');

// ---------------------------------------------------------------------
head('9. HTTP');
const port = 8097;
const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server start nahi hua')), 20000);
  child.stdout.on('data', (b) => {
    if (b.toString().includes('server.started')) { clearTimeout(t); resolve(); }
  });
  child.stderr.on('data', (b) => process.env.DEBUG && console.error(b.toString()));
});

const base = `http://127.0.0.1:${port}`;
try {
  ok((await fetch(`${base}/api/health`)).status === 200, 'GET /api/health -> 200');

  const setup = await (await fetch(`${base}/api/ivr/setup`)).json();
  ok(setup.checks?.db?.ok === true, 'setup: db ok', setup.checks?.db);
  ok(setup.checks?.view_rows?.ok === true, 'setup: view padhi gayi', setup.checks?.view_rows);
  ok(typeof setup.checks?.callable_now?.value === 'number', 'setup: callable_now number', setup.checks?.callable_now);

  ok((await fetch(`${base}/api/ivr/webhook?token=galat`, { method: 'POST' })).status === 403, 'galat token -> 403');
  ok((await fetch(`${base}/api/ivr/jobs`)).status === 401, 'bina admin token -> 401');

  const jobsRes = await (await fetch(`${base}/api/ivr/jobs?limit=5`, { headers: { 'x-admin-token': 'test-admin-token' } })).json();
  ok(Array.isArray(jobsRes.jobs), 'admin /jobs list');

  const st = await (await fetch(`${base}/api/ivr/stats`, { headers: { 'x-admin-token': 'test-admin-token' } })).json();
  ok(st.jobs.completed >= 1, 'stats: completed count', st.jobs);

  const ms = await (await fetch(`${base}/api/ivr/messages`, { headers: { 'x-admin-token': 'test-admin-token' } })).json();
  ok(ms.count >= 4, 'messages outbox endpoint', ms.count);

  const stg = await (await fetch(`${base}/api/ivr/settings`, { headers: { 'x-admin-token': 'test-admin-token' } })).json();
  ok(stg.settings.agentNumber === '+919876500099', 'settings: agent number API se', stg.settings.agentNumber);

  const page = await fetch(`${base}/ivr/settings`);
  const html = await page.text();
  ok(page.status === 200 && html.includes('agent_number'), 'settings page serve');

  // DTMF event endpoint — 1 dabao
  const { rows: j2 } = await q(
    `INSERT INTO call_jobs (customer_key, name, phone, reason, cycle_key, attempt, status, provider_call_sid)
     VALUES ('10babita10','10babita10','+917307130488','no_deposit_7d','TEST-EV',1,'calling','MOCK-EV') RETURNING *`,
  );
  await q(`DELETE FROM ivr_messages WHERE job_id=$1`, [j2[0].id]);
  const ev = await (await fetch(`${base}/api/ivr/event?step=digit1&token=test-webhook-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ CallSid: 'MOCK-EV', Digits: '1' }),
  })).json();
  ok(ev.action === 'send_link', 'event endpoint: action send_link', ev);
  ok(typeof ev.text === 'string' && ev.text.length > 10, 'event endpoint: Hindi text return hua');
  const { rows: evMsgs } = await q(`SELECT channel FROM ivr_messages WHERE job_id=$1 ORDER BY channel`, [j2[0].id]);
  ok(evMsgs.length === 2, 'event endpoint se 2 message queue', evMsgs);
  await q(`DELETE FROM call_jobs WHERE cycle_key='TEST-EV'`);

  const bad2 = await fetch(`${base}/api/ivr/event?step=digit1&token=galat`, { method: 'POST' });
  ok(bad2.status === 403, 'event bina token -> 403');
} finally {
  child.kill('SIGKILL');
}

// ---------------------------------------------------------------------
head('10. Raw payload save hua (debugging ke liye)');
const raw = (await q(`SELECT payload->>'Status' s FROM call_events WHERE kind='status' LIMIT 1`)).rows[0];
ok(raw?.s === 'completed' || raw?.s === 'no-answer', 'call_events me raw payload', raw);

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






