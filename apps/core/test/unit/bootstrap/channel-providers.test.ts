import { describe, expect, it } from 'vitest';

import { RuntimeSettings } from '@core/cli/runtime-settings.js';
import { BUILTIN_CHANNEL_PROVIDERS } from '@core/bootstrap/channel-providers.js';

function makeRuntimeSettings(enabled: {
  telegram: boolean;
  slack: boolean;
}): RuntimeSettings {
  const allowlist = {
    default: { allow: '*', mode: 'trigger' as const },
    agents: {},
    logDenied: true,
  };
  return {
    channels: {
      telegram: { enabled: enabled.telegram, senderAllowlist: allowlist },
      slack: { enabled: enabled.slack, senderAllowlist: allowlist },
    },
    memory: {
      enabled: true,
      provider: 'sqlite',
      sqlitePath: 'store/memory.db',
      embeddings: {
        enabled: false,
        provider: 'disabled',
        model: 'text-embedding-3-large',
      },
      dreaming: {
        enabled: false,
      },
      llm: {
        models: {
          extractor: 'claude-haiku-4-5-20251001',
          dreaming: 'claude-sonnet-4-6',
          consolidation: 'claude-sonnet-4-6',
          sessionSummary: 'claude-haiku-4-5-20251001',
        },
      },
    },
  };
}

describe('BUILTIN_CHANNEL_PROVIDERS', () => {
  it('keeps deterministic provider order and ids', () => {
    expect(BUILTIN_CHANNEL_PROVIDERS.map((provider) => provider.id)).toEqual([
      'slack',
      'telegram',
    ]);
  });

  it('resolves enablement from runtime settings', () => {
    const [slackProvider, telegramProvider] = BUILTIN_CHANNEL_PROVIDERS;

    expect(
      slackProvider.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: true }),
      ),
    ).toBe(true);
    expect(
      telegramProvider.isEnabled(
        makeRuntimeSettings({ telegram: true, slack: false }),
      ),
    ).toBe(true);
    expect(
      slackProvider.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: false }),
      ),
    ).toBe(false);
    expect(
      telegramProvider.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: false }),
      ),
    ).toBe(false);
  });
});
