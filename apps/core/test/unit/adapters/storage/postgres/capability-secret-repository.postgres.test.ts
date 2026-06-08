import { describe, expect, it, vi } from 'vitest';

import {
  encryptCapabilitySecretValue,
  PostgresCapabilitySecretRepository,
} from '@core/adapters/storage/postgres/repositories/capability-secret-repository.postgres.js';
import { SECRET_ENCRYPTION_KEY_ENV } from '@core/adapters/storage/postgres/repositories/credential-secret-crypto.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';

const key = Buffer.alloc(32, 9).toString('base64');

const runtimeSecrets: RuntimeSecretProvider = {
  getSecret(ref) {
    const value = this.getOptionalSecret(ref);
    if (!value) throw new Error(`${ref.env} missing`);
    return value;
  },
  getOptionalSecret(ref) {
    return ref.env === SECRET_ENCRYPTION_KEY_ENV ? key : undefined;
  },
};

function repositoryFor(row: { valueEncrypted: string }) {
  const fullRow = {
    id: 'capability-secret:default:LINKEDIN_ACCESS_TOKEN',
    appId: 'default',
    name: 'LINKEDIN_ACCESS_TOKEN',
    allowedCapabilityIdsJson: '[]',
    createdBy: 'cli',
    updatedBy: 'cli',
    createdAt: '2026-05-21T02:58:15.325Z',
    updatedAt: '2026-05-21T02:58:15.325Z',
    ...row,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [fullRow],
        }),
      }),
    }),
  };
  return new PostgresCapabilitySecretRepository(db as never, runtimeSecrets);
}

describe('PostgresCapabilitySecretRepository', () => {
  it('decrypts current capability secret envelopes', async () => {
    const valueEncrypted = encryptCapabilitySecretValue(
      'linkedin-token',
      {
        appId: 'default',
        name: 'LINKEDIN_ACCESS_TOKEN',
      },
      runtimeSecrets,
    );

    await expect(
      repositoryFor({ valueEncrypted }).getSecret({
        appId: 'default' as never,
        name: 'LINKEDIN_ACCESS_TOKEN',
      }),
    ).resolves.toMatchObject({
      name: 'LINKEDIN_ACCESS_TOKEN',
      value: 'linkedin-token',
    });
  });

  it('treats unsupported legacy capability secret envelopes as missing', async () => {
    await expect(
      repositoryFor({ valueEncrypted: 'enc:v1:iv:tag:ciphertext' }).getSecret({
        appId: 'default' as never,
        name: 'LINKEDIN_ACCESS_TOKEN',
      }),
    ).resolves.toBeNull();
  });

  it('logs an integrity failure so a bad key is distinguishable from an absent secret', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(
        repositoryFor({ valueEncrypted: 'enc:v1:iv:tag:ciphertext' }).getSecret(
          {
            appId: 'default' as never,
            name: 'LINKEDIN_ACCESS_TOKEN',
          },
        ),
      ).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
        appId: 'default',
        name: 'LINKEDIN_ACCESS_TOKEN',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
