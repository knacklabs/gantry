import { describe, expect, it, vi } from 'vitest';

import { AwsSecretsManagerRuntimeSecretProvider } from '@core/adapters/credentials/aws-secrets-manager-runtime-secret-provider.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';

function fallbackProvider(): RuntimeSecretProvider {
  return {
    getSecret: vi.fn(() => {
      throw new Error('missing');
    }),
    getOptionalSecret: vi.fn(() => undefined),
  };
}

describe('AwsSecretsManagerRuntimeSecretProvider', () => {
  it('returns undefined when an optional AWS secret cannot be resolved', async () => {
    const provider = new AwsSecretsManagerRuntimeSecretProvider(
      fallbackProvider(),
      'us-east-1',
    );
    (
      provider as unknown as {
        client: { send: ReturnType<typeof vi.fn> };
      }
    ).client = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('not found'), {
          name: 'ResourceNotFoundException',
        });
      }),
    };

    await expect(
      provider.getOptionalSecretAsync({ ref: 'aws-sm:prod/slack/bot' }),
    ).resolves.toBeUndefined();
  });

  it('propagates unexpected AWS client failures', async () => {
    const provider = new AwsSecretsManagerRuntimeSecretProvider(
      fallbackProvider(),
      'us-east-1',
    );
    (
      provider as unknown as {
        client: { send: ReturnType<typeof vi.fn> };
      }
    ).client = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('socket failed'), {
          name: 'UnexpectedNetworkError',
        });
      }),
    };

    await expect(
      provider.getOptionalSecretAsync({ ref: 'aws-sm:prod/slack/bot' }),
    ).rejects.toThrow('socket failed');
  });
});
