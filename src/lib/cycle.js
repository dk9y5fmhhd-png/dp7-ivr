// ISO week key, e.g. '2026-W47'
// Isi se ek customer ko ek hafte me ek hi baar call jaati hai.

export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function daysSince(dateLike, now = new Date()) {
  if (!dateLike) return Infinity;
  const t = new Date(dateLike).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((now.getTime() - t) / 86400000);
}

export default isoWeekKey;

