import { describe, expect, it } from 'vitest';

import {
  isProviderRuntimeSecretRefTarget,
  runtimeSecretNameForAgent,
  runtimeSecretNameForProviderAccount,
} from '@core/domain/provider/provider-runtime-secret-keys.js';

describe('runtimeSecretNameForProviderAccount', () => {
  it('is stable, readable, and account-scoped', () => {
    expect(
      runtimeSecretNameForProviderAccount(
        'slack',
        'slack_default',
        'BOT_TOKEN',
      ),
    ).toMatch(/^SLACK_SLACK_DEFAULT_[A-F0-9]{10}_BOT_TOKEN$/);
    expect(
      runtimeSecretNameForProviderAccount(
        'slack',
        'slack_default',
        'BOT_TOKEN',
      ),
    ).toBe(
      runtimeSecretNameForProviderAccount(
        'slack',
        'slack_default',
        'BOT_TOKEN',
      ),
    );
  });

  it('does not collide when account ids normalize to the same readable form', () => {
    expect(
      runtimeSecretNameForProviderAccount('slack', 'team/a', 'BOT_TOKEN'),
    ).not.toBe(
      runtimeSecretNameForProviderAccount('slack', 'team_a', 'BOT_TOKEN'),
    );
  });

  it('uses the agent display name for Slack credential names', () => {
    expect(runtimeSecretNameForAgent('slack', 'Test', 'BOT_TOKEN')).toBe(
      'TEST_SLACK_BOT_TOKEN',
    );
    expect(runtimeSecretNameForAgent('slack', 'Test', 'APP_TOKEN')).toBe(
      'TEST_SLACK_APP_TOKEN',
    );
  });

  it('creates isolated credential names for every channel provider', () => {
    expect(runtimeSecretNameForAgent('telegram', 'Test 2', 'BOT_TOKEN')).toBe(
      'TEST_2_TELEGRAM_BOT_TOKEN',
    );
    expect(
      runtimeSecretNameForAgent('discord', 'Test 2', 'APPLICATION_ID'),
    ).toBe('TEST_2_DISCORD_APPLICATION_ID');
    expect(runtimeSecretNameForAgent('teams', 'Test 2', 'CLIENT_SECRET')).toBe(
      'TEST_2_TEAMS_CLIENT_SECRET',
    );
  });

  it('accepts agent-scoped Gantry, env, and AWS secret references', () => {
    expect(
      isProviderRuntimeSecretRefTarget(
        'telegram',
        'bot_token',
        'gantry-secret:TEST2_TELEGRAM_BOT_TOKEN',
      ),
    ).toBe(true);
    expect(
      isProviderRuntimeSecretRefTarget(
        'discord',
        'bot_token',
        'env:TEST2_DISCORD_BOT_TOKEN',
      ),
    ).toBe(true);
    expect(
      isProviderRuntimeSecretRefTarget(
        'teams',
        'client_secret',
        'aws-sm:production/gantry/test2/teams-client-secret',
      ),
    ).toBe(true);
  });
});
