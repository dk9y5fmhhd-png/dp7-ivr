// JS mirror of the SQL normalize_phone() — worker aur webhook dono use karte hain
export function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^0-9]/g, '');
  if (!d) return null;

  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);

  if (d.length === 10 && /^[6-9]/.test(d)) return `+91${d}`;
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return `+${d}`;

  if (String(raw).trim().startsWith('+') && d.length >= 10 && d.length <= 15) return `+${d}`;
  return null;
}

export const isValidIndianMobile = (raw) => Boolean(normalizePhone(raw));

