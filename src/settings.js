// =====================================================================
//  Settings — DB se padho, env fallback.
//  Yahi wajah hai ki agent number badalne ke liye redeploy nahi chahiye.
// =====================================================================
import config from './lib/config.js';
import { q } from './lib/db.js';
import log from './lib/logger.js';

// DB se jo keys allowed hain — baaki kuch nahi
export const EDITABLE = {
  company_name: { type: 'string', label: 'Company naam', max: 40 },
  agent_number: { type: 'phone', label: 'Agent ka number (transfer isi pe jaayega)', max: 16 },
  support_number: { type: 'phone', label: 'Support number (script me bola jaata hai)', max: 16 },
  whatsapp_link: { type: 'string', label: 'WhatsApp link (customer ko bhejne ke liye)', max: 200 },
  website_link: { type: 'string', label: 'Website link (1 dabane pe SMS/WhatsApp me jaata hai)', max: 200 },
  min_deposit_rupees: { type: 'int', label: 'Minimum deposit (₹)', min: 1, max: 100000 },
  no_deposit_days: { type: 'int', label: 'Kitne din bina deposit pe call', min: 1, max: 90 },
  max_attempts: { type: 'int', label: 'Max attempts', min: 1, max: 10 },
  call_window_start: { type: 'int', label: 'Call shuru kab se (IST ghanta)', min: 0, max: 23 },
  call_window_end: { type: 'int', label: 'Call band kab tak (IST ghanta)', min: 1, max: 24 },
};

const CACHE_MS = 30_000;
let cache = null;
let cacheAt = 0;

/** env defaults — DB me row na ho to yahi chalega */
function envDefaults() {
  return {
    company_name: config.companyName,
    agent_number: config.agentNumber || '+919000000001',
    support_number: config.supportNumber || '9000000001',
    whatsapp_link: config.whatsappLink || '',
    website_link: config.websiteLink || '',
    min_deposit_rupees: String(config.minDepositRupees),
    no_deposit_days: String(config.noDepositDays),
    max_attempts: String(config.maxAttempts),
    call_window_start: '10',
    call_window_end: '21',
  };
}

export async function getRawSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;

  const rows = (await q('SELECT key, value FROM ivr_settings')).rows;
  const merged = { ...envDefaults() };
  for (const r of rows) merged[r.key] = r.value;
  cache = merged;
  cacheAt = Date.now();
  return merged;
}

const toInt = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

/** Typed view — code isi ko use karta hai */
export async function getSettings(opts = {}) {
  const s = await getRawSettings(opts);
  return {
    companyName: s.company_name,
    agentNumber: s.agent_number,
    supportNumber: s.support_number,
    whatsappLink: s.whatsapp_link,
    websiteLink: s.website_link,
    minDepositRupees: toInt(s.min_deposit_rupees, config.minDepositRupees),
    noDepositDays: toInt(s.no_deposit_days, config.noDepositDays),
    maxAttempts: toInt(s.max_attempts, config.maxAttempts),
    callWindowStart: toInt(s.call_window_start, 10),
    callWindowEnd: toInt(s.call_window_end, 21),
    raw: s,
  };
}

export function clearSettingsCache() {
  cache = null;
  cacheAt = 0;
}

/** validation — galat value DB me na jaaye */
export function validateSetting(key, value) {
  const def = EDITABLE[key];
  if (!def) return { ok: false, error: `"${key}" setting nahi hai` };

  const v = String(value ?? '').trim();
  if (!v) return { ok: false, error: `${def.label} khaali nahi ho sakta` };
  if (v.length > (def.max ?? 500)) return { ok: false, error: `${def.label} bahut lamba hai` };

  if (def.type === 'int') {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return { ok: false, error: `${def.label} number hona chahiye` };
    if (n < (def.min ?? 0) || n > (def.max ?? 1e9)) {
      return { ok: false, error: `${def.label} ${def.min}–${def.max} ke beech hona chahiye` };
    }
    return { ok: true, value: String(n) };
  }

  if (def.type === 'phone') {
    const digits = v.replace(/[^0-9+]/g, '');
    if (digits.replace(/\D/g, '').length < 10) {
      return { ok: false, error: `${def.label}: kam se kam 10 digit chahiye` };
    }
    // +91XXXXXXXXXX format me normalize
    let d = digits.replace(/\D/g, '');
    if (d.startsWith('0')) d = d.slice(1);
    if (d.length === 10) d = `91${d}`;
    return { ok: true, value: `+${d}` };
  }

  return { ok: true, value: v };
}

export async function updateSettings(patch, { by = 'admin' } = {}) {
  const applied = {};
  const errors = [];

  for (const [key, value] of Object.entries(patch ?? {})) {
    const res = validateSetting(key, value);
    if (!res.ok) {
      errors.push(res.error);
      continue;
    }
    await q(
      `INSERT INTO ivr_settings (key, value, updated_at, updated_by)
       VALUES ($1,$2,now(),$3)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [key, res.value, by],
    );
    applied[key] = res.value;
  }

  clearSettingsCache();
  if (Object.keys(applied).length) log.info('settings.updated', { keys: Object.keys(applied), by });
  return { applied, errors };
}

/** "10 se 21" window ke andar hai? IST ke hisaab se */
export function withinCallWindow(settings, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.cronTz,
    hour: '2-digit',
    hour12: false,
  });
  const h = Number(fmt.format(now));
  return h >= settings.callWindowStart && h < settings.callWindowEnd;
}

export default { getSettings, getRawSettings, updateSettings, validateSetting, withinCallWindow, EDITABLE };





