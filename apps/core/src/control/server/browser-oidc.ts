import { randomUUID } from 'node:crypto';

import {
  createOpaqueToken,
  expiresAt,
  hashAuthToken,
} from '../../application/auth/auth-foundations.js';
import type { RuntimeSecretProvider } from '../../domain/ports/runtime-secret-provider.js';
import { OidcAdapter } from '../../adapters/auth/oidc-adapter.js';
import { encryptCredentialSecretValue } from '../../adapters/storage/postgres/repositories/credential-secret-crypto.js';
import { PostgresAuthenticationRepository } from '../../adapters/storage/postgres/repositories/authentication-repository.postgres.js';

const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;

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
    const value = JSON.parse(raw ?? 'null');
    if (!isObject(value)) return null;
    const keys = [
      'issuer',
      'clientId',
      'clientSecretRef',
      'companyDomain',
      'providerLabel',
    ] as const;
    if (
      keys.some((key) => typeof value[key] !== 'string' || !value[key].trim())
    ) {
      return null;
    }
    return {
      issuer: value.issuer as string,
      clientId: value.clientId as string,
      clientSecretRef: value.clientSecretRef as string,
      companyDomain: value.companyDomain as string,
      providerLabel: value.providerLabel as string,
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
}): Promise<string> {
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
  return input.adapter.authorizationUrl({
    discovery,
    clientId: input.oidc.clientId,
    redirectUri: oidcRedirectUri(input.canonicalOrigin),
    state,
    nonce,
    codeVerifier: verifier,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
