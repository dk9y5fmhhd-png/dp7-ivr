// =====================================================================
//  Poora Hindi IVR script — ek jagah, taaki tune karna aasan ho.
//
//  DTMF mapping (client ne yahi chuna hai):
//    1 = website link WhatsApp + SMS pe bhejo
//    2 = naya ID banao aur bhejo
//    3 = agent se baat karo
//    9 = aisi call band karo (DND)
//
//  Rule: koi digit (7, 300, 1) seedha text me mat likho — TTS use English
//  me padh deta hai. Numbers hamesha rupeesToHindi/toHindiWords se aayein.
// =====================================================================
import { rupeesToHindi, toHindiWords } from '../lib/hindiNumbers.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** "Rahul Kumar" -> "Rahul" — phone pe poora naam bhaari lagta hai */
export function firstName(fullName) {
  const first = clean(fullName).split(' ')[0];
  return first || 'ग्राहक';
}

// ---------------------------------------------------------------------
// Block 1 — Opening
// ---------------------------------------------------------------------
export function welcome({ name, company }) {
  return clean(
    `नमस्ते, ${firstName(name)} जी। मैं ${company} से बात कर रही हूँ। ` +
      `यह कॉल आपके खाते के बारे में एक ज़रूरी जानकारी देने के लिए है।`,
  );
}

// ---------------------------------------------------------------------
// Block 2 — Main message (7 din no deposit)
// ---------------------------------------------------------------------
export function mainMessage({ name, days = 7, amountRupees = 300 }) {
  return clean(
    `${firstName(name)} जी, हमने देखा है कि पिछले ${toHindiWords(days)} दिनों से ` +
      `आपके खाते में कोई जमा नहीं हुआ है। ` +
      `आपका खाता अभी चालू है, लेकिन जमा न होने की वजह से आप सुविधाओं का पूरा फ़ायदा नहीं उठा पा रहे हैं। ` +
      `खाता चालू रखने के लिए कम से कम ${rupeesToHindi(amountRupees)} का जमा ज़रूरी है।`,
  );
}

// ---------------------------------------------------------------------
// Block 3 — Menu (DTMF)
//   1 = link | 2 = naya ID | 3 = agent | 9 = DND
// ---------------------------------------------------------------------
export function menu() {
  return clean(
    `वेबसाइट का लिंक व्हाट्सएप और मैसेज पर पाने के लिए एक दबाइए। ` +
      `नया आई डी बनवाने के लिए दो दबाइए। ` +
      `हमारी टीम से बात करने के लिए तीन दबाइए। ` +
      `अगर आप आगे ऐसी कॉल नहीं चाहते, तो नौ दबाइए।`,
  );
}

// ---------------------------------------------------------------------
// Branch responses — 1 / 2 / 3 / 9
// ---------------------------------------------------------------------
export function linkSent() {
  return clean(
    `धन्यवाद। वेबसाइट का लिंक आपको व्हाट्सएप और मैसेज दोनों पर भेज दिया गया है। ` +
      `कृपया एक बार देख लीजिए। धन्यवाद, आपका दिन शुभ हो।`,
  );
}

export function idCreated({ newId }) {
  const idLine = newId ? `आपकी नई आई डी ${toHindiWordsSpaced(String(newId))} है। ` : '';
  return clean(
    `धन्यवाद। ${idLine}` +
      `यह आई डी आपको व्हाट्सएप और मैसेज पर भी भेज दी गई है। ` +
      `इसी से लॉगिन कीजिए। धन्यवाद, आपका दिन शुभ हो।`,
  );
}

export function agentTransfer() {
  return clean(`धन्यवाद। मैं आपकी कॉल हमारी टीम से जोड़ रही हूँ। कृपया लाइन पर बने रहिए।`);
}

export function agentBusy({ supportNumber }) {
  return clean(
    `माफ़ कीजिए, हमारी सारी लाइनें व्यस्त हैं। हम आपको थोड़ी देर में कॉल करेंगे। ` +
      (supportNumber ? `आप ${toHindiWordsSpaced(supportNumber)} पर भी संपर्क कर सकते हैं। ` : '') +
      `धन्यवाद।`,
  );
}

export function optOut({ name }) {
  return clean(
    `ठीक है ${firstName(name)} जी, हम आपको ऐसी कॉल नहीं करेंगे। ` +
      `आपका नंबर हमारी सूची से हटा दिया गया है। धन्यवाद।`,
  );
}

export function noInputPrompt() {
  return clean(
    `कृपया एक दबाइए वेबसाइट का लिंक पाने के लिए, दो दबाइए नई आई डी के लिए, ` +
      `या तीन दबाइए हमारी टीम से बात करने के लिए।`,
  );
}

export function hangupNoInput() {
  return clean(`जैसा कि आप अभी व्यस्त हैं, हम आपको कुछ देर बाद दोबारा कॉल करेंगे। धन्यवाद।`);
}

export function retryMenu() {
  return clean(
    `आपने कोई विकल्प नहीं चुना। एक दबाइए लिंक के लिए, दो दबाइए नई आई डी के लिए, ` +
      `तीन दबाइए टीम से बात करने के लिए।`,
  );
}

// ---------------------------------------------------------------------
// Voicemail (call receive na ho to) — 15 sec
// ---------------------------------------------------------------------
export function voicemail({ name, days = 7, company, supportNumber }) {
  return clean(
    `नमस्ते, मैं ${company} से बात कर रही हूँ। ${firstName(name)} जी, पिछले ` +
      `${toHindiWords(days)} दिनों से आपके खाते में कोई जमा नहीं हुआ है। ` +
      `आपकी सुविधा के लिए हमने व्हाट्सएप पर लिंक भेजा है। ` +
      (supportNumber ? `किसी भी जानकारी के लिए ${toHindiWordsSpaced(supportNumber)} पर कॉल कीजिए। ` : '') +
      `धन्यवाद।`,
  );
}

// ---------------------------------------------------------------------
// 2nd aur 3rd attempt — chhota rakho, warna log cut kar dete hain
// ---------------------------------------------------------------------
export function secondAttempt({ name, company }) {
  return clean(
    `नमस्ते ${firstName(name)} जी, ${company} से। ` +
      `हमने पिछले हफ़्ते आपको जमा के बारे में कॉल किया था। ` +
      `एक दबाइए वेबसाइट के लिंक के लिए, दो दबाइए नई आई डी के लिए, ` +
      `तीन दबाइए टीम से बात करने के लिए।`,
  );
}

export function thirdAttempt({ name, company }) {
  return clean(
    `नमस्ते ${firstName(name)} जी। हमने आपको दो बार कॉल किया था। ` +
      `आपका खाता अभी भी चालू है। आख़िरी बार याद दिला रहे हैं — ` +
      `एक दबाइए लिंक के लिए, तीन दबाइए टीम से बात करने के लिए। धन्यवाद।`,
  );
}

export function closing() {
  return clean(`धन्यवाद। आपका दिन शुभ हो।`);
}

// Support number / ID ko digit-by-digit Hindi me — TTS use sahi padhta hai
export function toHindiWordsSpaced(num) {
  const digits = String(num).replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits
    .split('')
    .map((d) => toHindiWords(Number(d)))
    .join(' ');
}

// ---------------------------------------------------------------------
// Passthru applet ke liye: attempt ke hisaab se poora text ek saath
// ---------------------------------------------------------------------
export function buildCallScript(customer, opts = {}) {
  const attempt = Number(customer.attempt ?? 1);
  const base = {
    name: customer.name_tts ?? customer.name_hi ?? customer.name,
    company: opts.company,
    supportNumber: opts.supportNumber,
    whatsapp: opts.whatsappLink,
    amountRupees: customer.min_deposit_rupees ?? opts.amountRupees ?? 300,
    days: opts.days ?? 7,
  };

  if (attempt >= 3) {
    return { block: 'third', text: thirdAttempt(base) + ' ' + menu() };
  }
  if (attempt === 2) {
    return { block: 'second', text: secondAttempt(base) };
  }
  return {
    block: 'first',
    text: [welcome(base), mainMessage(base), menu()].join(' '),
  };
}

/** digit → kya karna hai (router aur script dono ke liye ek sach) */
export const DTMF_ACTIONS = {
  1: { action: 'send_link', disposition: 'link_sent', label: 'website link (WhatsApp + SMS)' },
  2: { action: 'new_id', disposition: 'id_created', label: 'naya ID' },
  3: { action: 'agent', disposition: 'interested', label: 'agent transfer' },
  9: { action: 'opt_out', disposition: 'opted_out', label: 'call band (DND)' },
};

export default {
  welcome,
  mainMessage,
  menu,
  linkSent,
  idCreated,
  agentTransfer,
  agentBusy,
  optOut,
  noInputPrompt,
  hangupNoInput,
  retryMenu,
  voicemail,
  secondAttempt,
  thirdAttempt,
  closing,
  buildCallScript,
  DTMF_ACTIONS,
};

