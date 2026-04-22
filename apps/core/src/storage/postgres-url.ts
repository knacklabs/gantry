export function parsePostgresConnectionUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid postgres connection URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      'Postgres URL must start with postgres:// or postgresql://',
    );
  }
  return parsed;
}

export function isLocalPostgresHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

export function validatePostgresConnectionUrl(url: string): void {
  const parsed = parsePostgresConnectionUrl(url);
  const sslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  if (isLocalPostgresHost(parsed.hostname)) return;
  if (
    !sslMode ||
    sslMode === 'disable' ||
    sslMode === 'allow' ||
    sslMode === 'prefer'
  ) {
    throw new Error(
      'Remote postgres URL must set sslmode=require (or stronger) for secure transport',
    );
  }
}
