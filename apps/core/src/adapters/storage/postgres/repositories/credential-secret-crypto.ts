import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import { EnvRuntimeSecretProvider } from '../../../credentials/env-runtime-secret-provider.js';
import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';

export const SECRET_ENCRYPTION_KEY_ENV = 'SECRET_ENCRYPTION_KEY';
export const SECRET_ENCRYPTION_KEYRING_ENV = 'SECRET_ENCRYPTION_KEYRING_JSON';

const CREDENTIAL_SECRET_FORMAT_VERSION = 'v2';
const CREDENTIAL_SECRET_PREFIX = `gcred:${CREDENTIAL_SECRET_FORMAT_VERSION}:`;

export type CredentialSecretAadContext = {
  appId: string;
  subjectKind: 'capability_secret' | 'model_credential';
  subjectId: string;
  authMode?: string;
  schemaVersion: number;
};

export class CredentialSecretCryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CredentialSecretCryptoConfigurationError extends CredentialSecretCryptoError {}

export class CredentialSecretCryptoIntegrityError extends CredentialSecretCryptoError {}

export function isCredentialSecretCryptoError(
  error: unknown,
): error is CredentialSecretCryptoError {
  return error instanceof CredentialSecretCryptoError;
}

function resolveCredentialSecretKey(runtimeSecrets: RuntimeSecretProvider): {
  key: Buffer;
  keyId: string;
} {
  const keyringJson = runtimeSecrets
    .getOptionalSecret({ env: SECRET_ENCRYPTION_KEYRING_ENV })
    ?.trim();
  if (keyringJson) {
    return resolveCredentialSecretKeyring(keyringJson);
  }
  const raw = runtimeSecrets
    .getOptionalSecret({ env: SECRET_ENCRYPTION_KEY_ENV })
    ?.trim();
  if (!raw) {
    throw new CredentialSecretCryptoConfigurationError(
      `${SECRET_ENCRYPTION_KEY_ENV} is required for Gantry credential encryption.`,
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) {
    return {
      key: decoded,
      keyId: createHash('sha256')
        .update('gantry-credential-secret-key')
        .update(decoded)
        .digest('hex')
        .slice(0, 16),
    };
  }
  throw new CredentialSecretCryptoConfigurationError(
    `${SECRET_ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte secret for Gantry credential encryption.`,
  );
}

function resolveCredentialSecretKeyById(
  runtimeSecrets: RuntimeSecretProvider,
  keyId: string,
): Buffer {
  const keyringJson = runtimeSecrets
    .getOptionalSecret({ env: SECRET_ENCRYPTION_KEYRING_ENV })
    ?.trim();
  if (keyringJson) {
    const keyring = parseCredentialSecretKeyring(keyringJson);
    const key = keyring.keys.get(keyId);
    if (!key) {
      throw new CredentialSecretCryptoConfigurationError(
        `Gantry credential encryption key ${keyId} is not configured.`,
      );
    }
    return key;
  }
  const active = resolveCredentialSecretKey(runtimeSecrets);
  if (keyId !== active.keyId) {
    throw new CredentialSecretCryptoIntegrityError(
      'Gantry credential ciphertext was encrypted with a different key.',
    );
  }
  return active.key;
}

export function encryptCredentialSecretValue(
  value: string,
  aadContext: CredentialSecretAadContext,
  runtimeSecrets: RuntimeSecretProvider = new EnvRuntimeSecretProvider(),
): string {
  const iv = randomBytes(12);
  const { key, keyId } = resolveCredentialSecretKey(runtimeSecrets);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(credentialSecretAad(aadContext));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'gcred',
    CREDENTIAL_SECRET_FORMAT_VERSION,
    keyId,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptCredentialSecretValue(
  stored: string,
  aadContext: CredentialSecretAadContext,
  runtimeSecrets: RuntimeSecretProvider = new EnvRuntimeSecretProvider(),
): string {
  if (!stored.startsWith(CREDENTIAL_SECRET_PREFIX)) {
    throw new CredentialSecretCryptoIntegrityError(
      'Gantry credential ciphertext format is unsupported.',
    );
  }
  const [_prefix, version, keyId, ivRaw, tagRaw, ciphertextRaw, extra] =
    stored.split(':');
  if (
    version !== CREDENTIAL_SECRET_FORMAT_VERSION ||
    !keyId ||
    !ivRaw ||
    !tagRaw ||
    !ciphertextRaw ||
    extra !== undefined
  ) {
    throw new CredentialSecretCryptoIntegrityError(
      'Gantry credential ciphertext is malformed.',
    );
  }
  const key = resolveCredentialSecretKeyById(runtimeSecrets, keyId);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAAD(credentialSecretAad(aadContext));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new CredentialSecretCryptoIntegrityError(
      'Gantry credential ciphertext failed authentication.',
      { cause: error },
    );
  }
}

function resolveCredentialSecretKeyring(raw: string): {
  key: Buffer;
  keyId: string;
} {
  const keyring = parseCredentialSecretKeyring(raw);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) {
    throw new CredentialSecretCryptoConfigurationError(
      `${SECRET_ENCRYPTION_KEYRING_ENV} active key is not present in keys.`,
    );
  }
  return { key, keyId: keyring.activeKeyId };
}

function parseCredentialSecretKeyring(raw: string): {
  activeKeyId: string;
  keys: Map<string, Buffer>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CredentialSecretCryptoConfigurationError(
      `${SECRET_ENCRYPTION_KEYRING_ENV} must be valid JSON.`,
      { cause: error },
    );
  }
  const record = parsed as { active?: unknown; keys?: unknown };
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.active !== 'string' ||
    !record.active.trim() ||
    !record.keys ||
    typeof record.keys !== 'object' ||
    Array.isArray(record.keys)
  ) {
    throw new CredentialSecretCryptoConfigurationError(
      `${SECRET_ENCRYPTION_KEYRING_ENV} must include active and keys.`,
    );
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(
    record.keys as Record<string, unknown>,
  )) {
    if (!keyId.trim() || typeof encoded !== 'string') {
      throw new CredentialSecretCryptoConfigurationError(
        `${SECRET_ENCRYPTION_KEYRING_ENV} keys must map key ids to base64 secrets.`,
      );
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== 32) {
      throw new CredentialSecretCryptoConfigurationError(
        `${SECRET_ENCRYPTION_KEYRING_ENV} key ${keyId} must be a base64-encoded 32-byte secret.`,
      );
    }
    keys.set(keyId, decoded);
  }
  if (!keys.has(record.active)) {
    throw new CredentialSecretCryptoConfigurationError(
      `${SECRET_ENCRYPTION_KEYRING_ENV} active key is not present in keys.`,
    );
  }
  return { activeKeyId: record.active, keys };
}

function credentialSecretAad(context: CredentialSecretAadContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      purpose: 'gantry-credential-secret',
      formatVersion: CREDENTIAL_SECRET_FORMAT_VERSION,
      appId: context.appId,
      subjectKind: context.subjectKind,
      subjectId: context.subjectId,
      authMode: context.authMode ?? null,
      schemaVersion: context.schemaVersion,
    }),
    'utf8',
  );
}
