import { describe, expect, it } from 'vitest';

import { RuntimeSettings } from '@core/cli/runtime-settings.js';
import '@core/channels/register-builtins.js';
import {
  getChannelProvider,
  listChannelProviders,
  providerForJid,
  registerChannelProvider,
} from '@core/channels/provider-registry.js';

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
      root: 'memory',
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
        },
      },
    },
  };
}

describe('listChannelProviders', () => {
  it('keeps deterministic provider order and ids', () => {
    expect(listChannelProviders().map((provider) => provider.id)).toEqual([
      'slack',
      'telegram',
    ]);
  });

  it('resolves enablement from runtime settings', () => {
    const [slackProvider, telegramProvider] = listChannelProviders();

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

  it('throws on duplicate provider ids', () => {
    expect(() =>
      registerChannelProvider({
        ...listChannelProviders()[0],
      }),
    ).toThrow(/Duplicate channel provider id/);
  });

  it('rejects empty provider identity fields', () => {
    const base = listChannelProviders()[0]!;

    expect(() => registerChannelProvider({ ...base, id: '   ' })).toThrow(
      /must be non-empty/,
    );
    expect(() =>
      registerChannelProvider({
        ...base,
        id: 'x-empty-prefix',
        jidPrefix: ' ',
      }),
    ).toThrow(/jidPrefix must be non-empty/);
    expect(() =>
      registerChannelProvider({
        ...base,
        id: 'x-empty-folder',
        jidPrefix: 'x:',
        folderPrefix: ' ',
      }),
    ).toThrow(/folderPrefix must be non-empty/);
  });

  it('rejects overlapping jid prefixes', () => {
    const base = listChannelProviders()[0]!;
    expect(() =>
      registerChannelProvider({
        ...base,
        id: 'slack-overlap',
        jidPrefix: 'sl',
        folderPrefix: 'slack_overlap_',
      }),
    ).toThrow(/jidPrefix overlap/);
  });

  it('resolves providers by channel id and jid prefix', () => {
    expect(getChannelProvider('telegram')?.id).toBe('telegram');
    expect(getChannelProvider('slack')?.id).toBe('slack');
    expect(providerForJid('tg:-100123')?.id).toBe('telegram');
    expect(providerForJid('sl:C123456')?.id).toBe('slack');
    expect(providerForJid('unknown:123')).toBeUndefined();
  });
});
