// =====================================================================
//  Poora Hindi IVR script — ek jagah, taaki tune karna aasan ho.
//  Har block apne aap me poora hai: Exotel me har applet ko alag text
//  chahiye hota hai, isliye yahan bhi alag-alag function hain.
//
//  Rule: koi digit (7, 300, 1) seedha text me mat likho — TTS use English
//  me padh deta hai. Numbers hamesha rupeesToHindi / words se aayein.
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
// ---------------------------------------------------------------------
export function menu() {
  return clean(
    `आगे बढ़ने के लिए अभी एक दबाइए, हमारी टीम से बात करने के लिए। ` +
      `यह संदेश दोबारा सुनने के लिए दो दबाइए। ` +
      `जमा का लिंक व्हाट्सएप पर पाने के लिए तीन दबाइए। ` +
      `अगर आप आगे ऐसी कॉल नहीं चाहते, तो नौ दबाइए।`,
  );
}

// ---------------------------------------------------------------------
// Branch responses
// ---------------------------------------------------------------------
export function agentTransfer() {
  return clean(
    `धन्यवाद। मैं आपकी कॉल हमारी टीम से जोड़ रही हूँ। कृपया लाइन पर बने रहिए।`,
  );
}

export function agentBusy({ supportNumber }) {
  return clean(
    `माफ़ कीजिए, हमारी सारी लाइनें व्यस्त हैं। हम आपको थोड़ी देर में कॉल करेंगे। ` +
      (supportNumber ? `आप ${toHindiWordsSpaced(supportNumber)} पर भी संपर्क कर सकते हैं। ` : '') +
      `धन्यवाद।`,
  );
}

export function whatsappSent({ whatsapp }) {
  return clean(
    `धन्यवाद। आपको जमा का लिंक अभी व्हाट्सएप पर भेज दिया गया है। ` +
      `कृपया अपना व्हाट्सएप देख लीजिए। धन्यवाद, आपका दिन शुभ हो।`,
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
    `कृपया एक दबाइए टीम से बात करने के लिए, या तीन दबाइए व्हाट्सएप पर लिंक पाने के लिए।`,
  );
}

export function hangupNoInput() {
  return clean(
    `जैसा कि आप अभी व्यस्त हैं, हम आपको कुछ देर बाद दोबारा कॉल करेंगे। धन्यवाद।`,
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
      `अभी एक दबाइए टीम से बात करने के लिए, या तीन दबाइए व्हाट्सएप पर जमा का लिंक पाने के लिए।`,
  );
}

export function thirdAttempt({ name, company }) {
  return clean(
    `नमस्ते ${firstName(name)} जी। हमने आपको दो बार कॉल किया था। ` +
      `आपका खाता अभी भी चालू है। आख़िरी बार याद दिला रहे हैं — ` +
      `अभी एक दबाइए टीम से बात करने के लिए। धन्यवाद।`,
  );
}

export function closing() {
  return clean(`धन्यवाद। आपका दिन शुभ हो।`);
}

// Support number ko digit-by-digit Hindi me — TTS use sahi padhta hai
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

export default {
  welcome,
  mainMessage,
  menu,
  agentTransfer,
  agentBusy,
  whatsappSent,
  optOut,
  noInputPrompt,
  hangupNoInput,
  voicemail,
  secondAttempt,
  thirdAttempt,
  closing,
  buildCallScript,
};



