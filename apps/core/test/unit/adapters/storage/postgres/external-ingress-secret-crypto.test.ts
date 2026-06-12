import { describe, expect, it } from 'vitest';

import {
  decryptExternalIngressSecret,
  encryptExternalIngressSecret,
  resolveExternalIngressSecretKey,
} from '@core/adapters/storage/postgres/repositories/control-plane-external-ingress.postgres.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';

function secrets(value?: string, keyring?: string): RuntimeSecretProvider {
  return {
    getSecret: () => {
      if (!value) throw new Error('SECRET_ENCRYPTION_KEY is required.');
      return value;
    },
    getOptionalSecret: (ref) => {
      if (ref.env === 'SECRET_ENCRYPTION_KEYRING_JSON') return keyring;
      return ref.env === 'SECRET_ENCRYPTION_KEY' ? value : undefined;
    },
  };
}

describe('external ingress secret crypto', () => {
  it('encrypts with a durable runtime secret provider key', () => {
    const runtimeSecrets = secrets(Buffer.alloc(32, 7).toString('base64'));

    const encrypted = encryptExternalIngressSecret(
      'webhook-secret',
      runtimeSecrets,
    );

    expect(encrypted).toMatch(/^enc:v1:/);
    expect(decryptExternalIngressSecret(encrypted, runtimeSecrets)).toBe(
      'webhook-secret',
    );
  });

  it('fails closed without a valid durable key', () => {
    expect(() => resolveExternalIngressSecretKey(secrets())).toThrow(
      'SECRET_ENCRYPTION_KEY or SECRET_ENCRYPTION_KEYRING_JSON is required',
    );
    expect(() => resolveExternalIngressSecretKey(secrets('short'))).toThrow(
      'base64-encoded 32-byte secret',
    );
    expect(() =>
      resolveExternalIngressSecretKey(
        secrets(
          undefined,
          JSON.stringify({
            active: 'primary',
            keys: { primary: Buffer.alloc(16, 1).toString('base64') },
          }),
        ),
      ),
    ).toThrow('base64-encoded 32-byte secret');
  });

  it('encrypts and decrypts with keyring-only runtime secrets', () => {
    const keyring = JSON.stringify({
      active: 'primary',
      keys: { primary: Buffer.alloc(32, 9).toString('base64') },
    });
    const runtimeSecrets = secrets(undefined, keyring);

    const encrypted = encryptExternalIngressSecret(
      'webhook-secret',
      runtimeSecrets,
    );

    expect(decryptExternalIngressSecret(encrypted, runtimeSecrets)).toBe(
      'webhook-secret',
    );
  });

  it('decrypts keyring secrets after active key rotation', () => {
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
    const encrypted = encryptExternalIngressSecret(
      'webhook-secret',
      secrets(undefined, oldRing),
    );

    expect(
      decryptExternalIngressSecret(encrypted, secrets(undefined, newRing)),
    ).toBe('webhook-secret');
  });

  it('rejects plaintext persisted secrets', () => {
    expect(() =>
      decryptExternalIngressSecret(
        'plaintext-webhook-secret',
        secrets(Buffer.alloc(32, 7).toString('base64')),
      ),
    ).toThrow('not encrypted');
  });
});
