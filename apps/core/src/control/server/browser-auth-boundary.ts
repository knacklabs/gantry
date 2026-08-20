import type { IncomingMessage, ServerResponse } from 'node:http';

import { matchesAuthToken } from '../../shared/auth-tokens.js';

export type BrowserAuthMode = 'local' | 'hosted';

export function browserSessionCookieName(mode: BrowserAuthMode): string {
  return mode === 'hosted' ? '__Host-gantry-session' : 'gantry_session';
}

export function browserCsrfCookieName(mode: BrowserAuthMode): string {
  return mode === 'hosted' ? '__Host-gantry-csrf' : 'gantry_csrf';
}

export function browserSessionCookie(
  mode: BrowserAuthMode,
  token: string,
  secure: boolean,
): string {
  const attributes = ['HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (secure || mode === 'hosted') attributes.push('Secure');
  return `${browserSessionCookieName(mode)}=${token}; ${attributes.join('; ')}`;
}

export function browserCsrfCookie(
  mode: BrowserAuthMode,
  token: string,
  secure: boolean,
): string {
  const attributes = ['SameSite=Strict', 'Path=/'];
  if (secure || mode === 'hosted') attributes.push('Secure');
  return `${browserCsrfCookieName(mode)}=${token}; ${attributes.join('; ')}`;
}

export function browserRequestHasBearer(req: IncomingMessage): boolean {
  return /^Bearer\s+\S+/i.test(req.headers.authorization || '');
}

export function apiRequestHasSessionCookie(req: IncomingMessage): boolean {
  return /(?:^|;\s*)(?:gantry_session|__Host-gantry-session)=/.test(
    req.headers.cookie || '',
  );
}

export function browserRequestHasCredentialConflict(
  req: IncomingMessage,
): boolean {
  return browserRequestHasBearer(req) && apiRequestHasSessionCookie(req);
}

export function browserSessionToken(
  req: IncomingMessage,
  mode: BrowserAuthMode,
): string | undefined {
  const name = browserSessionCookieName(mode);
  const match = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match?.slice(name.length + 1) || undefined;
}

export function isCanonicalBrowserOrigin(
  req: IncomingMessage,
  canonicalOrigin: string,
): boolean {
  return req.headers.origin === canonicalOrigin;
}

export function csrfMatches(
  provided: string | undefined,
  expectedHash: string,
): boolean {
  return Boolean(provided && matchesAuthToken(provided, expectedHash));
}

export function browserMutationPassesTrustBoundary(
  req: IncomingMessage,
  canonicalOrigin: string,
  providedCsrf: string | undefined,
  expectedCsrfHash: string,
): boolean {
  return (
    !browserRequestHasBearer(req) &&
    isCanonicalBrowserOrigin(req, canonicalOrigin) &&
    csrfMatches(providedCsrf, expectedCsrfHash)
  );
}

export function setNoStore(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
}

export function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return (
    hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  );
}
