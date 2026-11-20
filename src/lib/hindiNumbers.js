// Numbers -> Hindi shabd (Devanagari).
// Wajah: TTS "300" ko "three hundred" padh deta hai. "तीन सौ" likhne se
// awaaz sahi aati hai. Yeh function hi script ki quality decide karta hai.

const UNITS = [
  'शून्य', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ',
  'दस', 'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस',
];

const TENS = ['', '', 'बीस', 'तीस', 'चालीस', 'पचास', 'साठ', 'सत्तर', 'अस्सी', 'नब्बे'];

function twoDigit(n) {
  if (n < 20) return UNITS[n];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? TENS[t] : `${TENS[t]} ${UNITS[u]}`;
}

function threeDigit(n) {
  if (n < 100) return twoDigit(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  return r === 0 ? `${UNITS[h]} सौ` : `${UNITS[h]} सौ ${twoDigit(r)}`;
}

/** 0 se 99,99,99,999 tak. Indian numbering (lakh / crore). */
export function toHindiWords(n) {
  let num = Math.trunc(Math.abs(Number(n) || 0));
  if (num === 0) return UNITS[0];

  const parts = [];
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;

  if (crore) parts.push(`${twoDigit(crore)} करोड़`);
  if (lakh) parts.push(`${twoDigit(lakh)} लाख`);
  if (thousand) parts.push(`${twoDigit(thousand)} हज़ार`);
  if (num) parts.push(threeDigit(num));

  return parts.join(' ');
}

/** 300 -> "तीन सौ रुपये" */
export function rupeesToHindi(n) {
  return `${toHindiWords(n)} रुपये`;
}

export default toHindiWords;

