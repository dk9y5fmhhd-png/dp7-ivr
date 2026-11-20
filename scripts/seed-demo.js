// Demo data — testing ke liye 8 tarah ke customers
// Chalao: npm run seed
import { q, pool } from '../src/lib/db.js';
import log from '../src/lib/logger.js';

const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
const hours = (n) => new Date(Date.now() - n * 3600000).toISOString();

const DEMO = [
  // 8 din se deposit nahi -> call jaani chahiye
  { k: 'C-1001', n: 'Rahul Sharma', p: '+919812345001', d: days(8), active: true },
  // 20 din -> call jaani chahiye, Hindi naam (TTS ke liye best)
  { k: 'C-1002', n: 'Priya Verma', hi: 'प्रिया वर्मा', p: '9812345002', d: days(20), active: true },
  // 5 din pehle deposit -> NAHI jaani chahiye
  { k: 'C-1003', n: 'Amit Kumar', p: '09812345003', d: days(5), active: true },
  // active nahi -> NAHI jaani chahiye
  { k: 'C-1004', n: 'Sneha Gupta', p: '9812345004', d: days(30), active: false },
  // do_not_call -> NAHI jaani chahiye
  { k: 'C-1005', n: 'Vikram Singh', p: '9812345005', d: days(15), active: true, dnc: true },
  // phone invalid -> NAHI jaani chahiye
  { k: 'C-1006', n: 'Kiran Rao', p: '12345', d: days(10), active: true },
  // 6 din 23 ghante — 7 din se KAM -> NAHI jaani chahiye
  { k: 'C-1007', n: 'Deepak Yadav', p: '9812345007', d: hours(167), active: true },
  // 9 din, phone with dashes -> call jaani chahiye
  { k: 'C-1008', n: 'Meena Joshi', p: '+91-98123-45008', d: days(9), active: true },
];

export async function seedDemo() {
  for (const c of DEMO) {
    await q(
      `INSERT INTO ivr_customers (customer_key, name, name_hi, phone, last_deposit_at, min_deposit_rupees, is_active, do_not_call, source)
       VALUES ($1,$2,$3,$4,$5,300,$6,$7,'seed')
       ON CONFLICT (customer_key) DO UPDATE SET
         name=EXCLUDED.name, name_hi=EXCLUDED.name_hi, phone=EXCLUDED.phone,
         last_deposit_at=EXCLUDED.last_deposit_at,
         is_active=EXCLUDED.is_active, do_not_call=EXCLUDED.do_not_call, updated_at=now()`,
      [c.k, c.n, c.hi ?? null, c.p, c.d, c.active, Boolean(c.dnc)],
    );
  }
  log.info('seed.done', { count: DEMO.length });
}

const isMain = process.argv[1] && process.argv[1].endsWith('seed-demo.js');
if (isMain) {
  seedDemo()
    .then(() => pool.end())
    .catch(async (e) => {
      log.error('seed.failed', { err: e.message });
      await pool.end();
      process.exit(1);
    });
}



