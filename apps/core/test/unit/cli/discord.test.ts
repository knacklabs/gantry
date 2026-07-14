import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from '@core/config/env/file.js';
import { envFilePath } from '@core/config/settings/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const groupsStore = vi.hoisted(() => new Map<string, any>());

vi.mock('@core/cli/runtime-group-db.js', () => ({
  openRuntimeGroupDb: async () => ({
    getAllConversationRoutes: async () =>
      Object.fromEntries(groupsStore.entries()),
    setConversationRoute: async (jid: string, group: any) => {
      groupsStore.set(jid, group);
    },
    getFileArtifactStore: () => undefined,
    close: async () => {},
  }),
}));

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  groupsStore.clear();
  while (runtimeHomes.length > 0) {
    const runtimeHome = runtimeHomes.pop();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

function mockRuntimeSecretStorage() {
  const storeRuntimeSecretInput = vi.fn(async () => undefined);
  vi.doMock('@core/cli/credentials.js', () => ({
    storeRuntimeSecretInput,
  }));
  return storeRuntimeSecretInput;
}

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-discord-test-'),
  );
  saveRuntimeSettings(runtimeHome, loadRuntimeSettings(runtimeHome));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

function mockPrompts(selectValue: string) {
  const error = vi.fn();
  const info = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note: vi.fn(),
    password: vi.fn(async () => 'discord-token'),
    text: vi.fn(async () => '123456789'),
    select: vi.fn(async () => selectValue),
    outro: vi.fn(),
    log: { success: vi.fn(), error, info },
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  }));
  return { error, info };
}

function fakeDiscordDiscovery(overrides: Record<string, any> = {}) {
  return {
    validateCredentials: vi.fn(async () => ({
      ok: true,
      message: 'Discord bot token validated.',
    })),
    listChannels: vi.fn(async () => ({
      ok: true,
      message: 'ok',
      channels: [
        {
          chatJid: 'dc:1234567890',
          chatTitle: 'Engineering / #general',
          guildId: '987654321',
          guildName: 'Engineering',
          channelId: '1234567890',
          channelName: 'general',
          channelType: 'text',
        },
      ],
    })),
    verifyChannel: vi.fn(async () => ({
      ok: true,
      message: 'Discord channel verified.',
      chatJid: 'dc:1234567890',
      chatTitle: 'Engineering / #general',
    })),
    registerGantryCommand: vi.fn(async () => ({
      ok: true,
      message: 'Registered Discord /gantry command.',
    })),
    ...overrides,
  };
}

describe('cli discord helpers', () => {
  it('saves Discord credentials without enabling runtime before registration', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    mockPrompts('skip');
    const discovery = fakeDiscordDiscovery();
    const storeRuntimeSecretInput = mockRuntimeSecretStorage();

    const { runDiscordConnectCommand } = await import('@core/cli/discord.js');
    const code = await runDiscordConnectCommand(runtimeHome, discovery);

    expect(code).toBe(0);
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'DISCORD_BOT_TOKEN',
      value: 'discord-token',
      actor: 'cli:discord-connect',
    });
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'DISCORD_APPLICATION_ID',
      value: '123456789',
      actor: 'cli:discord-connect',
    });
    expect(readEnvFile(envFilePath(runtimeHome))).not.toHaveProperty(
      'DISCORD_BOT_TOKEN',
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.providers.discord.enabled).toBe(false);
    expect(settings.providerAccounts.discord_default).toMatchObject({
      provider: 'discord',
      runtimeSecretRefs: {
        bot_token: 'gantry-secret:DISCORD_BOT_TOKEN',
        application_id: 'gantry-secret:DISCORD_APPLICATION_ID',
      },
    });
  });

  it('preserves an enabled Discord provider when rerun skips registration', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.providers.discord.enabled = true;
    saveRuntimeSettings(runtimeHome, settings);
    mockPrompts('skip');
    mockRuntimeSecretStorage();

    const { runDiscordConnectCommand } = await import('@core/cli/discord.js');
    const code = await runDiscordConnectCommand(
      runtimeHome,
      fakeDiscordDiscovery(),
    );

    expect(code).toBe(0);
    expect(loadRuntimeSettings(runtimeHome).providers.discord.enabled).toBe(
      true,
    );
  });

  it('fails before registering a conversation when Discord command setup fails', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const { error, info } = mockPrompts('dc:1234567890');
    mockRuntimeSecretStorage();
    const discovery = fakeDiscordDiscovery({
      registerGantryCommand: vi.fn(async () => ({
        ok: false,
        message: 'Discord /gantry command registration failed.',
        nextAction: 'Install the app with applications.commands.',
      })),
    });

    const { runDiscordConnectCommand } = await import('@core/cli/discord.js');
    const code = await runDiscordConnectCommand(runtimeHome, discovery);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'Discord /gantry command registration failed.',
    );
    expect(info).toHaveBeenCalledWith(
      'Install the app with applications.commands.',
    );
    expect(groupsStore.size).toBe(0);
    expect(readEnvFile(envFilePath(runtimeHome))).not.toHaveProperty(
      'DISCORD_BOT_TOKEN',
    );
  });

  it('registers a selected Discord channel and enables runtime transport', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    mockPrompts('dc:1234567890');
    const discovery = fakeDiscordDiscovery();
    const storeRuntimeSecretInput = mockRuntimeSecretStorage();

    const { runDiscordConnectCommand } = await import('@core/cli/discord.js');
    const code = await runDiscordConnectCommand(runtimeHome, discovery);

    expect(code).toBe(0);
    expect(loadRuntimeSettings(runtimeHome).providers.discord.enabled).toBe(
      true,
    );
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'DISCORD_BOT_TOKEN',
      value: 'discord-token',
      actor: 'cli:discord-connect',
    });
    expect(groupsStore.get('dc:1234567890')).toEqual(
      expect.objectContaining({ folder: 'main_agent' }),
    );
  });
});
