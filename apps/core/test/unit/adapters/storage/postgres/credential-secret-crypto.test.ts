import { describe, expect, it } from 'vitest';

import {
  decryptCredentialSecretValue,
  encryptCredentialSecretValue,
  isCredentialSecretCryptoError,
  SECRET_ENCRYPTION_KEY_ENV,
  SECRET_ENCRYPTION_KEYRING_ENV,
  type CredentialSecretAadContext,
} from '@core/adapters/storage/postgres/repositories/credential-secret-crypto.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';

const key = Buffer.alloc(32, 7).toString('base64');

function provider(
  raw: string | undefined = key,
  keyring?: string,
): RuntimeSecretProvider {
  return {
    getSecret(ref) {
      const value = this.getOptionalSecret(ref);
      if (!value) throw new Error(`${ref.env} missing`);
      return value;
    },
    getOptionalSecret(ref) {
      if (ref.env === SECRET_ENCRYPTION_KEYRING_ENV) return keyring;
      return ref.env === SECRET_ENCRYPTION_KEY_ENV ? raw : undefined;
    },
  };
}

const modelContext: CredentialSecretAadContext = {
  appId: 'default',
  subjectKind: 'model_credential',
  subjectId: 'anthropic',
  authMode: 'api_key',
  schemaVersion: 1,
};

describe('credential secret crypto', () => {
  it('encrypts and decrypts a credential with a versioned key id envelope', () => {
    const encrypted = encryptCredentialSecretValue(
      'plain-secret',
      modelContext,
      provider(),
    );

    expect(encrypted).toMatch(/^gcred:v2:[0-9a-f]{16}:/);
    expect(encrypted).not.toContain('plain-secret');
    expect(
      decryptCredentialSecretValue(encrypted, modelContext, provider()),
    ).toBe('plain-secret');
  });

  it('rejects ciphertext when credential metadata AAD changes', () => {
    const encrypted = encryptCredentialSecretValue(
      'plain-secret',
      modelContext,
      provider(),
    );

    expect(() =>
      decryptCredentialSecretValue(
        encrypted,
        { ...modelContext, subjectId: 'openai' },
        provider(),
      ),
    ).toThrow(/failed authentication/i);
  });

  it('encrypts plaintext that looks like a credential envelope', () => {
    const fakeEnvelope = 'gcred:v2:not-a-real-ciphertext';

    const encrypted = encryptCredentialSecretValue(
      fakeEnvelope,
      modelContext,
      provider(),
    );

    expect(encrypted).not.toBe(fakeEnvelope);
    expect(
      decryptCredentialSecretValue(encrypted, modelContext, provider()),
    ).toBe(fakeEnvelope);
  });

  it('rejects unsupported legacy enc:v1 ciphertext without fallback decrypt', () => {
    expect(() =>
      decryptCredentialSecretValue(
        'enc:v1:iv:tag:ciphertext',
        modelContext,
        provider(),
      ),
    ).toThrow(/unsupported/i);
  });

  it('decrypts old keyring entries after active key rotation', () => {
    const oldKey = Buffer.alloc(32, 3).toString('base64');
    const newKey = Buffer.alloc(32, 4).toString('base64');
    const oldRing = JSON.stringify({
      active: 'old-key',
      keys: { 'old-key': oldKey, 'new-key': newKey },
    });
    const newRing = JSON.stringify({
      active: 'new-key',
      keys: { 'old-key': oldKey, 'new-key': newKey },
    });
    const encrypted = encryptCredentialSecretValue(
      'plain-secret',
      modelContext,
      provider(undefined, oldRing),
    );

    expect(encrypted).toContain('gcred:v2:old-key:');
    expect(
      decryptCredentialSecretValue(
        encrypted,
        modelContext,
        provider(undefined, newRing),
      ),
    ).toBe('plain-secret');
  });

  it('classifies missing encryption key as a crypto error', () => {
    expect(() =>
      encryptCredentialSecretValue('plain-secret', modelContext, provider('')),
    ).toThrow(/SECRET_ENCRYPTION_KEY/);
    try {
      encryptCredentialSecretValue('plain-secret', modelContext, provider(''));
    } catch (error) {
      expect(isCredentialSecretCryptoError(error)).toBe(true);
    }
  });
});
