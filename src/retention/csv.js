// Chhota CSV parser — dependency-free, quotes handle karta hai
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text).replace(/^\uFEFF/, ''); // BOM hatao

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      /* ignore */
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const HEADER_ALIASES = {
  customer_key: ['customer_key', 'client_id', 'user_id', 'id', 'customer_id', 'uid'],
  name: ['name', 'client_name', 'customer_name', 'full_name', 'username'],
  name_hi: ['name_hi', 'name_hindi', 'hindi_name', 'name_local'],
  phone: ['phone', 'mobile', 'mobile_no', 'phone_no', 'contact', 'number', 'whatsapp'],
  last_deposit_at: ['last_deposit_at', 'last_deposit', 'last_deposit_date', 'last_deposit_on', 'deposit_date'],
  min_deposit_rupees: ['min_deposit_rupees', 'min_deposit', 'min_amount', 'amount'],
  is_active: ['is_active', 'active', 'status'],
  do_not_call: ['do_not_call', 'dnc', 'opt_out'],
  language: ['language', 'lang'],
};

function headerIndex(headers) {
  const map = {};
  const norm = headers.map((h) => String(h).trim().toLowerCase().replace(/[\s-]+/g, '_'));
  for (const [target, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = norm.findIndex((h) => aliases.includes(h));
    if (idx >= 0) map[target] = idx;
  }
  return map;
}

const truthy = (v, d = true) => {
  if (v === undefined || String(v).trim() === '') return d;
  return ['1', 'true', 'yes', 'y', 'active', 'on'].includes(String(v).trim().toLowerCase());
};

export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  // ISO
  const iso = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(iso)) return new Date(iso);

  // DD/MM/YYYY ya DD-MM-YYYY (India ka sabse common Excel format)
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  if (!Number.isNaN(iso)) return new Date(iso);
  return null;
}

/**
 * CSV text -> normalized rows + rejected rows with reason
 */
export function parseRetentionCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { rows: [], bad: [{ reason: 'CSV khaali hai ya sirf header hai' }], headers: [] };

  const headers = rows[0];
  const idx = headerIndex(headers);
  const missing = ['customer_key', 'name', 'phone'].filter((k) => idx[k] === undefined);
  if (missing.length) {
    return {
      rows: [],
      bad: [{ reason: `yeh columns nahi mile: ${missing.join(', ')}`, headers }],
      headers,
    };
  }

  const out = [];
  const bad = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (idx[k] === undefined ? undefined : r[idx[k]]);

    const customer_key = String(get('customer_key') ?? '').trim();
    const name = String(get('name') ?? '').trim();
    const phone = String(get('phone') ?? '').trim();

    if (!customer_key) {
      bad.push({ line: i + 1, reason: 'customer_key khaali', row: r });
      continue;
    }
    if (!name) {
      bad.push({ line: i + 1, reason: 'name khaali', customer_key });
      continue;
    }
    if (!phone) {
      bad.push({ line: i + 1, reason: 'phone khaali', customer_key });
      continue;
    }

    const minDep = Number(String(get('min_deposit_rupees') ?? '').replace(/[^0-9.]/g, ''));

    out.push({
      customer_key,
      name,
      name_hi: String(get('name_hi') ?? '').trim() || null,
      phone,
      last_deposit_at: parseDate(get('last_deposit_at')),
      min_deposit_rupees: Number.isFinite(minDep) && minDep > 0 ? Math.round(minDep) : null,
      is_active: truthy(get('is_active'), true),
      do_not_call: ['1', 'true', 'yes', 'y', 'on'].includes(
        String(get('do_not_call') ?? '').trim().toLowerCase(),
      ),
      language: String(get('language') ?? 'hi').trim() || 'hi',
    });
  }

  return { rows: out, bad, headers };
}

export default parseRetentionCsv;




