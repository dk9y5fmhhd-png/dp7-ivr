// Chhota structured logger. Credentials kabhi print nahi hote.
// sirf asli credential names redact hote hain — customer_key jaisi cheez nahi
const SENSITIVE = /(api[_-]?key|apikey|api[_-]?token|access[_-]?token|auth[_-]?token|password|secret|authorization)$/i;

const redact = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v);
  }
  return out;
};

const emit = (level, msg, meta) => {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? redact(meta) : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else console.log(text);
};

export const log = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};

export default log;


