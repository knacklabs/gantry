import { describe, expect, it } from 'vitest';

import { getProviderRuntimeSecret } from '@core/channels/provider-runtime-secrets.js';

describe('provider runtime secrets', () => {
  it('resolves refs from the exact Provider Account only', async () => {
    const secrets = {
      getSecret() {
        return '';
      },
      getOptionalSecret(ref: { ref?: string }) {
        return {
          'gantry-secret:SLACK_A': 'token-a',
          'gantry-secret:SLACK_B': 'token-b',
        }[ref.ref ?? ''];
      },
    };
    const settings = {
      providerAccounts: {
        'provider-account:a': {
          provider: 'slack',
          runtimeSecretRefs: { bot_token: 'gantry-secret:SLACK_A' },
        },
        'provider-account:b': {
          provider: 'slack',
          runtimeSecretRefs: { bot_token: 'gantry-secret:SLACK_B' },
        },
      },
    };

    await expect(
      getProviderRuntimeSecret({
        providerId: 'slack',
        providerAccountId: 'provider-account:a',
        key: 'bot_token',
        settings,
        secrets,
      }),
    ).resolves.toBe('token-a');
    await expect(
      getProviderRuntimeSecret({
        providerId: 'slack',
        providerAccountId: 'provider-account:b',
        key: 'bot_token',
        settings,
        secrets,
      }),
    ).resolves.toBe('token-b');
  });

  it('does not fall across Provider Accounts or provider types', async () => {
    const settings = {
      providerAccounts: {
        'provider-account:a': {
          provider: 'telegram',
          runtimeSecretRefs: { bot_token: 'gantry-secret:TG' },
        },
      },
    };

    await expect(
      getProviderRuntimeSecret({
        providerId: 'slack',
        providerAccountId: 'provider-account:a',
        key: 'bot_token',
        settings,
        secrets: {
          getSecret: () => 'wrong',
          getOptionalSecret: () => 'wrong',
        },
      }),
    ).resolves.toBe('');
  });

  it('requires an exact Provider Account match', async () => {
    const settings = {
      providerAccounts: {
        'provider-account:other': {
          provider: 'slack',
          runtimeSecretRefs: { bot_token: 'gantry-secret:OTHER' },
        },
      },
    };

    await expect(
      getProviderRuntimeSecret({
        providerId: 'slack',
        providerAccountId: 'provider-account:missing',
        key: 'bot_token',
        settings,
        secrets: {
          getSecret: () => 'wrong',
          getOptionalSecret: () => 'wrong',
        },
      }),
    ).resolves.toBe('');
  });
});
