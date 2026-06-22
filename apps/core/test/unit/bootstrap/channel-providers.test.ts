import { describe, expect, it } from 'vitest';

import { RuntimeSettings } from '@core/config/settings/runtime-settings.js';
import '@core/channels/register-builtins.js';
import {
  getProvider,
  listChannelProviders,
  normalizeProviderId,
  providerForJid,
  providerIdForJid,
  registerProvider,
} from '@core/channels/provider-registry.js';

function makeRuntimeSettings(enabled: {
  telegram: boolean;
  slack: boolean;
  discord?: boolean;
  teams?: boolean;
  [key: string]: boolean;
}): RuntimeSettings {
  return {
    providers: {
      telegram: { enabled: enabled.telegram },
      slack: { enabled: enabled.slack },
      discord: { enabled: enabled.discord ?? false },
      teams: { enabled: enabled.teams ?? false },
      ...Object.fromEntries(
        Object.entries(enabled)
          .filter(
            ([key]) =>
              key !== 'telegram' &&
              key !== 'slack' &&
              key !== 'discord' &&
              key !== 'teams',
          )
          .map(([key, value]) => [key, { enabled: value }]),
      ),
    },
    memory: {
      enabled: true,
      embeddings: {
        enabled: false,
        provider: 'disabled',
        model: 'text-embedding-3-small',
      },
      dreaming: {
        enabled: false,
      },
      llm: {
        models: {
          extractor: 'haiku',
          dreaming: 'sonnet',
          consolidation: 'sonnet',
        },
      },
    },
    runtime: {
      queue: {
        maxMessageRuns: 3,
        maxJobRuns: 4,
        maxRetries: 5,
        baseRetryMs: 5000,
      },
    },
  };
}

describe('listChannelProviders', () => {
  it('keeps deterministic provider order and ids', () => {
    expect(listChannelProviders().map((provider) => provider.id)).toEqual([
      'app',
      'discord',
      'slack',
      'teams',
      'telegram',
    ]);
  });

  it('resolves enablement from runtime settings', () => {
    const slackProvider = getProvider('slack')!;
    const discordProvider = getProvider('discord')!;
    const teamsProvider = getProvider('teams')!;
    const telegramProvider = getProvider('telegram')!;
    const appProvider = getProvider('app')!;

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
      discordProvider.isEnabled(
        makeRuntimeSettings({
          telegram: false,
          slack: false,
          discord: true,
        }),
      ),
    ).toBe(true);
    expect(
      discordProvider.isEnabled(
        makeRuntimeSettings({
          telegram: false,
          slack: false,
          discord: false,
        }),
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
      registerProvider({
        ...listChannelProviders()[0],
      }),
    ).toThrow(/Duplicate provider id/);
  });

  it('rejects empty provider identity fields', () => {
    const base = listChannelProviders()[0]!;

    expect(() => registerProvider({ ...base, id: '   ' })).toThrow(
      /must be non-empty/,
    );
    expect(() =>
      registerProvider({
        ...base,
        id: 'x-empty-prefix',
        jidPrefix: ' ',
      }),
    ).toThrow(/jidPrefix must be non-empty/);
    expect(() =>
      registerProvider({
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
      registerProvider({
        ...base,
        id: 'slack-overlap',
        jidPrefix: 'sl',
        folderPrefix: 'slack_overlap_',
      }),
    ).toThrow(/jidPrefix overlap/);
  });

  it('resolves providers by channel id and jid prefix', () => {
    expect(getProvider('telegram')?.id).toBe('telegram');
    expect(getProvider('slack')?.id).toBe('slack');
    expect(getProvider('discord')?.id).toBe('discord');
    expect(getProvider('teams')?.id).toBe('teams');
    expect(providerForJid('tg:-100123')?.id).toBe('telegram');
    expect(providerForJid('sl:C123456')?.id).toBe('slack');
    expect(providerForJid('dc:123456789')?.id).toBe('discord');
    expect(providerForJid('teams:19:abc@thread.v2')?.id).toBe('teams');
    expect(providerForJid('unknown:123')).toBeUndefined();
    expect(providerIdForJid('tg:-100123')).toBe('telegram');
    expect(providerIdForJid('sl:C123456')).toBe('slack');
    expect(providerIdForJid('dc:123456789')).toBe('discord');
    expect(providerIdForJid('teams:19:abc@thread.v2')).toBe('teams');
    expect(providerIdForJid('unknown:123', '')).toBe('');
    expect(normalizeProviderId('tg')).toBe('telegram');
    expect(normalizeProviderId('sl')).toBe('slack');
    expect(normalizeProviderId('dc')).toBe('discord');
    expect(normalizeProviderId('unknown')).toBe('');
  });

  it('supports a third provider in registry and settings checks', () => {
    const id = `test-provider-${Date.now()}`;
    registerProvider({
      ...listChannelProviders()[0]!,
      id,
      jidPrefix: `tp${Date.now()}:`,
      folderPrefix: `tp_${Date.now()}_`,
      isEnabled: (settings) => settings.providers[id]?.enabled === true,
    });

    const provider = getProvider(id);
    expect(provider).toBeDefined();
    expect(
      provider?.isEnabled(
        makeRuntimeSettings({ telegram: false, slack: false, [id]: true }),
      ),
    ).toBe(true);
    expect(providerForJid(provider!.jidPrefix + 'abc')?.id).toBe(id);
  });
});
