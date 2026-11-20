// =====================================================================
//  Daily deposit file ka parser — CSV aur XLSX dono
//
//  Ek username ke kai deposit aate hain. Hum har row ko deposit maante
//  hain (append), aur "last deposit" view me MAX() se nikalta hai.
// =====================================================================
import XLSX from 'xlsx';
import { parseDate } from './csv.js';
import { parseCsv } from './csv.js';
import { normalizePhone } from '../lib/phone.js';

// ---------------------------------------------------------------------
// Column ke naam — deposit reports me ye sab dikhte hain
// ---------------------------------------------------------------------
const ALIASES = {
  username: [
    'username', 'user_name', 'user', 'login', 'login_id', 'player_id', 'playerid',
    'client_username', 'customer_username', 'customer_key', 'member', 'member_id',
    'userid', 'user_id', 'client_id', 'customer_id',
  ],
  deposit_at: [
    'deposit_at', 'deposit_date', 'date', 'datetime', 'date_time', 'txn_date',
    'transaction_date', 'created_at', 'credit_date', 'approved_on', 'approved_at',
    'deposit_time', 'time', 'timestamp',
  ],
  amount_rupees: [
    'amount_rupees', 'amount', 'deposit_amount', 'amt', 'credit', 'credit_amount',
    'rupees', 'inr', 'total', 'deposit',
  ],
  phone: ['phone', 'mobile', 'mobile_no', 'phoneno', 'contact', 'contact_no', 'number', 'whatsapp'],
  name: ['name', 'full_name', 'customer_name', 'display_name', 'client_name'],
  txn_ref: ['txn_ref', 'utr', 'utr_no', 'reference', 'ref_no', 'transaction_id', 'txn_id', 'order_id'],
};

const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s\-.]+/g, '_');

/** header row dhoondo — file me upar title rows ho sakti hain */
function findHeaderRow(rows, maxScan = 15) {
  let best = { idx: -1, score: 0, map: null };

  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const cells = rows[i].map(norm);
    const map = {};
    let score = 0;

    for (const [role, list] of Object.entries(ALIASES)) {
      const at = cells.findIndex((c) => c && list.includes(c));
      if (at >= 0) {
        // ek cell do role ke liye na le liya jaaye
        if (Object.values(map).includes(at)) continue;
        map[role] = at;
        score++;
      }
    }

    // username + date zaroori hain, warna wo header nahi hai
    const usable = map.username !== undefined && map.deposit_at !== undefined;
    if (usable && score > best.score) best = { idx: i, score, map };
  }

  return best;
}

/** Excel serial number (45000 jaisa) ko date me */
function excelSerialToDate(n) {
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  // Excel epoch: 1899-12-30
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateCell(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'number') return excelSerialToDate(v);
  const s = String(v ?? '').trim();
  if (!s) return null;
  const direct = parseDate(s);
  if (direct) return direct;
  // "2026-11-20 14:32:00" jaisa — space wala time
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})[ T](\d{1,2}):(\d{2})/);
  if (m) {
    let [, dd, mm, yy, hh, mi] = m;
    if (yy.length === 2) yy = `20${yy}`;
    const d = new Date(Date.UTC(+yy, +mm - 1, +dd, +hh, +mi));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

const toAmount = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};

// ---------------------------------------------------------------------
// Sheet -> rows
// ---------------------------------------------------------------------
function sheetToRows(buffer, isXlsx) {
  if (isXlsx) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    // pehli sheet lo (kaafi exports me ek hi hoti hai)
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  }
  const text = buffer.toString('utf8');
  return parseCsv(text);
}

/**
 * Buffer -> normalized deposit rows + rejected rows
 * @returns {{rows: Array, bad: Array, headers: string[], headerRow: number}}
 */
export function parseDepositFile(buffer, { isXlsx = false } = {}) {
  const grid = sheetToRows(buffer, isXlsx);
  if (!grid.length) return { rows: [], bad: [{ reason: 'file khaali hai' }], headers: [], headerRow: -1 };

  const head = findHeaderRow(grid);
  if (head.idx < 0) {
    return {
      rows: [],
      bad: [
        {
          reason:
            'header row nahi mili — file me "username" aur "date" (ya deposit_date) wale columns hone chahiye',
          firstRows: grid.slice(0, 3),
        },
      ],
      headers: [],
      headerRow: -1,
    };
  }

  const headers = grid[head.idx].map((h) => String(h ?? '').trim());
  const rows = [];
  const bad = [];

  for (let i = head.idx + 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || r.every((c) => String(c ?? '').trim() === '')) continue;

    const get = (role) => (head.map[role] === undefined ? undefined : r[head.map[role]]);

    const username = String(get('username') ?? '').trim();
    if (!username) {
      bad.push({ line: i + 1, reason: 'username khaali', row: r.slice(0, 6) });
      continue;
    }

    const depositAt = parseDateCell(get('deposit_at'));
    if (!depositAt) {
      bad.push({ line: i + 1, username, reason: `date samajh nahi aayi: "${get('deposit_at')}"` });
      continue;
    }

    rows.push({
      username,
      deposit_at: depositAt,
      amount_rupees: toAmount(get('amount_rupees')),
      txn_ref: get('txn_ref') ? String(get('txn_ref')).trim() : null,
      phone: get('phone') ? normalizePhone(get('phone')) : null,
      name: get('name') ? String(get('name')).trim() : null,
      raw: Object.fromEntries(headers.map((h, idx) => [h || `col${idx}`, r[idx] ?? ''])),
    });
  }

  return { rows, bad, headers, headerRow: head.idx + 1 };
}

export default parseDepositFile;

