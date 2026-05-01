import { describe, expect, it } from 'vitest';

import { RuntimeSettings } from '@core/config/settings/runtime-settings.js';
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
  teams?: boolean;
  [key: string]: boolean;
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
      teams: { enabled: enabled.teams ?? false, senderAllowlist: allowlist },
      ...Object.fromEntries(
        Object.entries(enabled)
          .filter(
            ([key]) => key !== 'telegram' && key !== 'slack' && key !== 'teams',
          )
          .map(([key, value]) => [
            key,
            { enabled: value, senderAllowlist: allowlist },
          ]),
      ),
    },
    memory: {
      enabled: true,
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
      'app',
      'slack',
      'teams',
      'telegram',
    ]);
  });

  it('resolves enablement from runtime settings', () => {
    const slackProvider = getChannelProvider('slack')!;
    const teamsProvider = getChannelProvider('teams')!;
    const telegramProvider = getChannelProvider('telegram')!;
    const appProvider = getChannelProvider('app')!;

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
    expect(
      teamsProvider.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: false, teams: true }),
      ),
    ).toBe(true);
    expect(
      teamsProvider.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: false, teams: false }),
      ),
    ).toBe(false);
    expect(
      appProvider.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: false }),
      ),
    ).toBe(true);
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
    expect(getChannelProvider('teams')?.id).toBe('teams');
    expect(providerForJid('tg:-100123')?.id).toBe('telegram');
    expect(providerForJid('sl:C123456')?.id).toBe('slack');
    expect(providerForJid('teams:19:abc@thread.v2')?.id).toBe('teams');
    expect(providerForJid('unknown:123')).toBeUndefined();
  });

  it('supports a third provider in registry and settings checks', () => {
    const id = `test-provider-${Date.now()}`;
    registerChannelProvider({
      ...listChannelProviders()[0]!,
      id,
      jidPrefix: `tp${Date.now()}:`,
      folderPrefix: `tp_${Date.now()}_`,
      isEnabled: (settings) => settings.channels[id]?.enabled === true,
    });

    const provider = getChannelProvider(id);
    expect(provider).toBeDefined();
    expect(
      provider?.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: false, [id]: true }),
      ),
    ).toBe(true);
    expect(providerForJid(provider!.jidPrefix + 'abc')?.id).toBe(id);
  });
});
