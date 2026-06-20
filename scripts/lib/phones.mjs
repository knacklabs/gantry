import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEV_PHONE_PREFIX = '000';
const DEV_PHONE_COUNT = 999;

export function phonesFromEnvValue(value) {
  const phones = new Set();
  for (const raw of String(value || '').split(/[\s,]+/)) {
    const digits = raw.replace(/\D/g, '');
    if (digits) phones.add(digits);
  }
  return phones;
}

function runtimeEnvPath() {
  return path.join(process.env.GANTRY_HOME || path.join(os.homedir(), 'gantry'), '.env');
}

function readDotenvValue(key) {
  const filePath = runtimeEnvPath();
  if (!fs.existsSync(filePath)) return '';
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || match[1] !== key) continue;
    const raw = match[2] ?? '';
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return '';
}

export function configuredOperatorPhones() {
  return phonesFromEnvValue(
    process.env.GANTRY_TEST_OPERATOR_PHONE || readDotenvValue('GANTRY_TEST_OPERATOR_PHONE'),
  );
}

export const ALL_TEST_PHONES = Array.from({ length: DEV_PHONE_COUNT }, (_, index) =>
  String(index + 1).padStart(9, '0'),
);

export function isAllowedTestPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return false;
  if (digits.startsWith(DEV_PHONE_PREFIX)) return configuredOperatorPhones().size > 0;
  return configuredOperatorPhones().has(digits);
}

export const OPERATOR_LIST = [...ALL_TEST_PHONES, ...configuredOperatorPhones()].join(',');
