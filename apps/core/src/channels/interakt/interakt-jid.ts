// JID helpers for the Interakt (WhatsApp Business) channel.
//
// Format: `wa:<E.164 digits without +>`, e.g. `wa:917003705584` for +91 70037 05584.
// The prefix is declared at register-builtins.ts and validated against existing
// prefixes (app:, sl:, teams:, tg:) by provider-registry.ts:80-88.

export const INTERAKT_JID_PREFIX = 'wa:';

const PHONE_DIGIT_PATTERN = /^\d{8,15}$/;

// Static table of E.164 country-code prefixes. IANA-assigned, deterministic
// (each prefix has a unique length). Used to split a JID's digits into
// {countryCode, phoneNumber} for the Interakt send endpoint, which requires
// them separated. Phase 2 TODO: switch to libphonenumber-js.
const COUNTRY_CODE_PREFIXES: readonly string[] = [
  // 3-digit codes (longest-first match)
  '247',
  '290',
  '297',
  '298',
  '299',
  '350',
  '351',
  '352',
  '353',
  '354',
  '355',
  '356',
  '357',
  '358',
  '359',
  '370',
  '371',
  '372',
  '373',
  '374',
  '375',
  '376',
  '377',
  '378',
  '379',
  '380',
  '381',
  '382',
  '383',
  '385',
  '386',
  '387',
  '389',
  '420',
  '421',
  '423',
  '500',
  '501',
  '502',
  '503',
  '504',
  '505',
  '506',
  '507',
  '508',
  '509',
  '590',
  '591',
  '592',
  '593',
  '594',
  '595',
  '596',
  '597',
  '598',
  '599',
  '670',
  '672',
  '673',
  '674',
  '675',
  '676',
  '677',
  '678',
  '679',
  '680',
  '681',
  '682',
  '683',
  '685',
  '686',
  '687',
  '688',
  '689',
  '690',
  '691',
  '692',
  '800',
  '808',
  '850',
  '852',
  '853',
  '855',
  '856',
  '870',
  '878',
  '880',
  '881',
  '882',
  '883',
  '886',
  '888',
  '960',
  '961',
  '962',
  '963',
  '964',
  '965',
  '966',
  '967',
  '968',
  '970',
  '971',
  '972',
  '973',
  '974',
  '975',
  '976',
  '977',
  '979',
  '992',
  '993',
  '994',
  '995',
  '996',
  '998',
  // 2-digit codes
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
  // 1-digit codes
  '1',
  '7',
];

export function interaktJidFromPhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (!PHONE_DIGIT_PATTERN.test(digits)) return null;
  return `${INTERAKT_JID_PREFIX}${digits}`;
}

export function isInteraktJid(jid: string): boolean {
  return jid.startsWith(INTERAKT_JID_PREFIX);
}

export interface InteraktPhoneParts {
  countryCode: string;
  phoneNumber: string;
}

export function phoneFromInteraktJid(jid: string): InteraktPhoneParts | null {
  if (!isInteraktJid(jid)) return null;
  const digits = jid.slice(INTERAKT_JID_PREFIX.length);
  if (!PHONE_DIGIT_PATTERN.test(digits)) return null;
  // Match longest prefix first; the static table is already in
  // longest-first order, but enforce explicitly for safety.
  const candidates = [...COUNTRY_CODE_PREFIXES].sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of candidates) {
    if (digits.startsWith(prefix) && digits.length > prefix.length) {
      return {
        countryCode: prefix,
        phoneNumber: digits.slice(prefix.length),
      };
    }
  }
  return null;
}
