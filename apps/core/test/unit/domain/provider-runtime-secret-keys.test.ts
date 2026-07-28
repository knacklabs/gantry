import { describe, expect, it } from 'vitest';

import {
  runtimeSecretNameForProviderAccount,
  slackRuntimeSecretNameForAgent,
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
    expect(slackRuntimeSecretNameForAgent('Test', 'BOT_TOKEN')).toBe(
      'TEST_SLACK_BOT_TOKEN',
    );
    expect(slackRuntimeSecretNameForAgent('Test', 'APP_TOKEN')).toBe(
      'TEST_SLACK_APP_TOKEN',
    );
  });
});
