import { randomUUID } from 'node:crypto';

import {
  createOpaqueToken,
  expiresAt,
  hashAuthToken,
  matchesAuthToken,
} from '../../application/auth/auth-foundations.js';
import {
  normalizeRuntimeSecretRefString,
  type RuntimeSecretProvider,
} from '../../domain/ports/runtime-secret-provider.js';
import { OidcAdapter } from '../../adapters/auth/oidc-adapter.js';
import { encryptCredentialSecretValue } from '../../adapters/storage/postgres/repositories/credential-secret-crypto.js';
import { PostgresAuthenticationRepository } from '../../adapters/storage/postgres/repositories/authentication-repository.postgres.js';

const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;

function oidcStateCookieName(canonicalOrigin: string): string {
  return new URL(canonicalOrigin).protocol === 'https:'
    ? '__Host-gantry-oidc-state'
    : 'gantry_oidc_state';
}

export function oidcStateCookie(
  canonicalOrigin: string,
  state: string,
): string {
  const secure = new URL(canonicalOrigin).protocol === 'https:';
  return `${oidcStateCookieName(canonicalOrigin)}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${OIDC_TRANSACTION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function expiredOidcStateCookie(canonicalOrigin: string): string {
  const secure = new URL(canonicalOrigin).protocol === 'https:';
  return `${oidcStateCookieName(canonicalOrigin)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function oidcStateMatches(
  cookieHeader: string | undefined,
  canonicalOrigin: string,
  state: string,
): boolean {
  const name = oidcStateCookieName(canonicalOrigin);
  const token = (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return Boolean(token && matchesAuthToken(token, hashAuthToken(state)));
}

export type OidcConfiguration = {
  issuer: string;
  clientId: string;
  clientSecretRef: string;
  companyDomain: string;
  providerLabel: string;
};

export function oidcRedirectUri(canonicalOrigin: string): string {
  return new URL('/auth/oidc/callback', canonicalOrigin).toString();
}

export function parseTransactionOidcConfig(
  raw: string | null,
): OidcConfiguration | null {
  try {
    return parseOidcConfiguration(JSON.parse(raw ?? 'null'));
  } catch {
    return null;
  }
}

export function parseOidcConfiguration(
  value: unknown,
): OidcConfiguration | null {
  if (!isObject(value)) return null;
  const keys = [
    'issuer',
    'clientId',
    'clientSecretRef',
    'companyDomain',
    'providerLabel',
  ] as const;
  if (keys.some((key) => typeof value[key] !== 'string' || !value[key].trim()))
    return null;
  try {
    const issuer = new URL((value.issuer as string).trim());
    const companyDomain = (value.companyDomain as string).trim().toLowerCase();
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      !/^[a-z0-9.-]+$/i.test(companyDomain)
    )
      return null;
    return {
      issuer: issuer.toString().replace(/\/$/, ''),
      clientId: (value.clientId as string).trim(),
      clientSecretRef: normalizeRuntimeSecretRefString(
        value.clientSecretRef as string,
        'OIDC client secret ref',
      ),
      companyDomain,
      providerLabel: (value.providerLabel as string).trim(),
    };
  } catch {
    return null;
  }
}

export async function beginOidcSignIn(input: {
  appId: string;
  canonicalOrigin: string;
  oidc: OidcConfiguration;
  adapter: OidcAdapter;
  repository: PostgresAuthenticationRepository;
  secrets: RuntimeSecretProvider;
  configurationTest?: boolean;
  invitationTokenHash?: string;
  reauthenticateUserId?: string;
  reauthenticateSessionHash?: string;
  prompt?: 'login';
}): Promise<{ authorizationUrl: string; state: string }> {
  const discovery = await input.adapter.discover(input.oidc.issuer);
  const id = randomUUID();
  const state = createOpaqueToken();
  const nonce = createOpaqueToken();
  const verifier = createOpaqueToken();
  const now = new Date();
  await input.repository.createOidcTransaction({
    id,
    appId: input.appId,
    stateHash: hashAuthToken(state),
    nonceHash: hashAuthToken(nonce),
    encryptedPkceVerifier: encryptCredentialSecretValue(
      verifier,
      {
        appId: input.appId,
        subjectKind: 'oidc_transaction',
        subjectId: id,
        schemaVersion: 1,
      },
      input.secrets,
    ),
    ...(input.configurationTest
      ? { oidcConfigJson: JSON.stringify(input.oidc) }
      : {}),
    configurationTest: input.configurationTest ?? false,
    ...(input.invitationTokenHash
      ? { invitationTokenHash: input.invitationTokenHash }
      : {}),
    ...(input.reauthenticateUserId
      ? { reauthenticateUserId: input.reauthenticateUserId }
      : {}),
    ...(input.reauthenticateSessionHash
      ? { reauthenticateSessionHash: input.reauthenticateSessionHash }
      : {}),
    expiresAt: expiresAt(now, OIDC_TRANSACTION_TTL_MS).toISOString(),
    now: now.toISOString(),
  });
  return {
    authorizationUrl: input.adapter.authorizationUrl({
      discovery,
      clientId: input.oidc.clientId,
      redirectUri: oidcRedirectUri(input.canonicalOrigin),
      state,
      nonce,
      codeVerifier: verifier,
      ...(input.prompt ? { prompt: input.prompt } : {}),
    }),
    state,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
