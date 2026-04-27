import { redactString } from '../../../infrastructure/logging/logger.js';

export function redactPostgresUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid postgres url>';
  }
}

export function redactPostgresDetail(value: string): string {
  return redactString(value);
}
