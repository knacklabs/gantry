import { describe, expect, it } from 'vitest';

import {
  decryptExternalIngressSecret,
  encryptExternalIngressSecret,
  resolveExternalIngressSecretKey,
} from '@core/adapters/storage/postgres/repositories/control-plane-external-ingress.postgres.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';

function secrets(value?: string): RuntimeSecretProvider {
  return {
    getSecret: () => {
      if (!value) throw new Error('SECRET_ENCRYPTION_KEY is required.');
      return value;
    },
    getOptionalSecret: () => value,
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
      'SECRET_ENCRYPTION_KEY is required',
    );
    expect(() => resolveExternalIngressSecretKey(secrets('short'))).toThrow(
      'base64-encoded 32-byte secret',
    );
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
