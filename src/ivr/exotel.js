// Exotel Connect API client
// - Basic auth HEADER me jaata hai, URL me nahi (URL logs me leak hota hai)
// - EXOTEL_MOCK=1 -> koi asli call nahi, fake SID. Testing ke liye.
import crypto from 'node:crypto';
import config from '../lib/config.js';
import log from '../lib/logger.js';

const authHeader = () =>
  'Basic ' + Buffer.from(`${config.exotel.apiKey}:${config.exotel.apiToken}`).toString('base64');

export class ExotelError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ExotelError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Ek outbound call trigger karo.
 * From = customer, To = IVR flow number, CallerId = jo customer ko dikhega.
 */
export async function connectCall({ to, jobId, customField }) {
  const customerPhone = to;

  if (config.exotel.mock) {
    const sid = 'MOCK-' + crypto.randomUUID().slice(0, 8);
    log.info('exotel.mock connect', { jobId, to: customerPhone, sid });
    return { sid, status: 'in-progress', mock: true };
  }

  const params = new URLSearchParams({
    From: customerPhone,
    To: config.exotel.flowNumber,
    CallerId: config.exotel.callerId,
    TimeLimit: String(config.callTimeLimitSec),
    Timeout: String(config.callTimeoutSec),
    Record: config.recordCalls ? 'true' : 'false',
    StatusCallback: `${config.publicBaseUrl}/api/ivr/webhook?token=${encodeURIComponent(config.tokens.webhook)}`,
    'StatusCallbackEvents[0]': 'terminal',
    CustomField: customField ?? String(jobId ?? ''),
    CallType: 'trans',
  });

  const url = `https://${config.exotel.subdomain}/v1/Accounts/${config.exotel.sid}/Calls/connect.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  if (!res.ok) {
    // id/phone ke alawa kuch log nahi karte
    log.error('exotel.connect failed', { status: res.status, jobId, body });
    throw new ExotelError(`Exotel connect failed (${res.status})`, { status: res.status, body });
  }

  const call = body?.Call ?? body;
  return {
    sid: call?.Sid ?? call?.sid ?? null,
    status: call?.Status ?? call?.status ?? 'in-progress',
    raw: body,
  };
}

/**
 * Provider ke status field ko hamare statuses me badalta hai.
 * Field names plan/applet ke hisaab se thode badal sakte hain — isliye
 * yahan aliases ka fallback rakha hai. Pehli asli call ka raw payload
 * call_events table me milega, usse confirm kar lena.
 */
export function mapStatus(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/[\s_]/g, '-');
  if (['completed', 'complete', 'answered'].includes(s)) return 'completed';
  if (['no-answer', 'noanswer', 'noanswer-machine', 'unanswered'].includes(s)) return 'no_answer';
  if (['busy', 'call-busy'].includes(s)) return 'busy';
  if (['failed', 'failure', 'error'].includes(s)) return 'failed';
  if (['canceled', 'cancelled'].includes(s)) return 'failed';
  if (['in-progress', 'ringing', 'queued', 'initiated'].includes(s)) return 'in_progress';
  return 'unknown';
}

/** Provider ka response kabhi nested hota hai — flatten kar dete hain */
export function flattenPayload(body = {}) {
  const root = body.Call ?? body.call ?? body;
  const out = {};
  for (const [k, v] of Object.entries(root)) {
    if (v !== null && typeof v === 'object') continue;
    out[k] = v;
  }
  return out;
}

export const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
};

export default { connectCall, mapStatus, flattenPayload, pick };

