export function parsePostgresConnectionUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error('Invalid postgres connection URL', { cause: err });
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      'Postgres URL must start with postgres:// or postgresql://',
    );
  }
  return parsed;
}

const FLEET_REHEARSAL_POSTGRES_HOSTS = ['postgres'] as const;

export function fleetRehearsalPlaintextPostgresHosts(
  env: Partial<Record<string, string | undefined>> = process.env,
): readonly string[] {
  return env.GANTRY_FLEET_REHEARSAL_AUTO_SECRETS?.trim() === '1'
    ? FLEET_REHEARSAL_POSTGRES_HOSTS
    : [];
}

export function isLocalPostgresHost(
  hostname: string,
  plaintextHostAllowlist: readonly string[] = [],
): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    plaintextHostAllowlist.some(
      (host) => host.trim().toLowerCase() === normalized,
    )
  );
}

export interface ValidatePostgresConnectionUrlOptions {
  allowLocalhost?: boolean;
  plaintextHostAllowlist?: readonly string[];
}

export function validatePostgresConnectionUrl(
  url: string,
  options: ValidatePostgresConnectionUrlOptions = {},
): void {
  const allowLocalhost = options.allowLocalhost ?? true;
  const parsed = parsePostgresConnectionUrl(url);
  if (isLocalPostgresHost(parsed.hostname, options.plaintextHostAllowlist)) {
    if (allowLocalhost) return;
    throw new Error('Local Postgres URLs are not allowed in this context');
  }
  const sslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
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
