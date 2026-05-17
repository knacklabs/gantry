import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as p from '@clack/prompts';
import {
  loadRuntimeSettingsFromPath,
  parseRuntimeSettings,
  saveRuntimeSettings,
  validateRuntimeSettings,
  ensureConfiguredConversationBinding,
} from '@core/config/settings/runtime-settings.js';
import { parseRuntimeMemorySnapshotFromRoot } from '@core/config/settings/memory-snapshot.js';
import {
  envFilePath,
  settingsFilePath,
} from '@core/config/settings/runtime-home.js';

const groupsStore = vi.hoisted(() => new Map<string, any>());
const messagesStore = vi.hoisted(() => new Map<string, any[]>());
const fileArtifacts = vi.hoisted(() => new Map<string, string>());
const fileArtifactStore = vi.hoisted(() => ({
  async listFileArtifacts(input: any) {
    return [...fileArtifacts.keys()]
      .filter((key) =>
        key.startsWith(
          `${input.appId}:${input.agentId}:${input.virtualScope}:`,
        ),
      )
      .filter(
        (key) => !input.virtualPath || key.endsWith(`:${input.virtualPath}`),
      )
      .map((key, index) => {
        const [, , scope, path] = key.split(':');
        return {
          id: `file-artifact:test:${index + 1}`,
          scope,
          path,
          version: 1,
          contentHash: `hash-${index + 1}`,
          sizeBytes: fileArtifacts.get(key)?.length ?? 0,
          contentType: 'text/markdown',
          createdAt: new Date(0).toISOString(),
        };
      });
  },
  async writeFileArtifact(input: any) {
    const key = `${input.appId}:${input.agentId}:${input.virtualScope}:${input.virtualPath}`;
    fileArtifacts.set(key, String(input.content));
    return {
      id: `file-artifact:test:${fileArtifacts.size}`,
      appId: input.appId,
      agentId: input.agentId,
      virtualScope: input.virtualScope,
      virtualPath: input.virtualPath,
      version: 1,
      storageType: 'local-filesystem',
      storageRef: 'memory://test',
      contentHash: `hash-${fileArtifacts.size}`,
      sizeBytes: String(input.content).length,
      contentType: input.contentType ?? 'text/markdown',
      metadata: input.metadata ?? {},
      createdAt: new Date(0).toISOString(),
      createdBy: input.createdBy,
    };
  },
  async readFileArtifact(input: any) {
    const key = `${input.appId}:${input.agentId}:${input.virtualScope}:${input.virtualPath}`;
    const content = fileArtifacts.get(key);
    if (content === undefined) throw new Error('File artifact not found');
    return {
      artifact: {
        id: 'file-artifact:test:read',
        appId: input.appId,
        agentId: input.agentId,
        virtualScope: input.virtualScope,
        virtualPath: input.virtualPath,
        version: 1,
        storageType: 'local-filesystem',
        storageRef: 'memory://test',
        contentHash: 'hash-read',
        sizeBytes: content.length,
        contentType: 'text/markdown',
        metadata: {},
        createdAt: new Date(0).toISOString(),
      },
      content,
    };
  },
  async promoteScratch() {
    throw new Error('not used');
  },
}));

vi.mock('@core/cli/runtime-group-db.js', () => ({
  openRuntimeGroupDb: async () => ({
    countConversationRoutesByJidPrefix: async (jidPrefix: string) => {
      const normalized = jidPrefix.endsWith('%')
        ? jidPrefix.slice(0, -1)
        : jidPrefix;
      return Array.from(groupsStore.keys()).filter((jid) =>
        jid.startsWith(normalized),
      ).length;
    },
    getAllConversationRoutes: async () =>
      Object.fromEntries(groupsStore.entries()),
    getMessagesSince: async (chatJid: string) =>
      messagesStore.get(chatJid) || [],
    setConversationRoute: async (jid: string, group: any) => {
      groupsStore.set(jid, group);
    },
    deleteConversationRoute: async (jid: string) => {
      groupsStore.delete(jid);
    },
    deleteSession: async () => {},
    getFileArtifactStore: () => fileArtifactStore,
    close: async () => {},
  }),
}));

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-group-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(
    settingsFilePath(home),
    [
      'providers:',
      '  telegram:',
      '    enabled: false',
      '  slack:',
      '    enabled: false',
      'storage:',
      '  postgres:',
      '    url_env: MYCLAW_DATABASE_URL',
      '    schema: myclaw',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      '  llm:',
      '    models:',
      '      extractor: haiku',
      '      dreaming: sonnet',
      '      consolidation: sonnet',
      '',
    ].join('\n'),
    'utf-8',
  );
  return home;
}

function updateCredentialBrokerSettings(updates: {
  mode?: 'none' | 'onecli' | 'external';
  onecliUrl?: string;
  externalBaseUrl?: string;
}): void {
  const filePath = settingsFilePath(runtimeHome);
  const settings = loadRuntimeSettingsFromPath(filePath);
  if (updates.mode) settings.credentialBroker.mode = updates.mode;
  if (updates.onecliUrl !== undefined) {
    settings.credentialBroker.onecli.url = updates.onecliUrl;
  }
  if (updates.externalBaseUrl !== undefined) {
    settings.credentialBroker.external.baseUrl = updates.externalBaseUrl;
  }
  saveRuntimeSettings(runtimeHome, settings);
}

let runtimeHome = '';

beforeEach(() => {
  vi.resetModules();
  groupsStore.clear();
  messagesStore.clear();
  fileArtifacts.clear();
  runtimeHome = createRuntimeHome();
  process.env.MYCLAW_HOME = runtimeHome;
  process.env.MYCLAW_DATABASE_URL =
    'postgres://user:pass@127.0.0.1:5432/myclaw';
  process.env.ONECLI_DATABASE_URL =
    'postgres://onecli:pass@127.0.0.1:5432/myclaw?schema=onecli';
  process.env.SECRET_ENCRYPTION_KEY =
    'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY=';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MYCLAW_DATABASE_URL;
  delete process.env.ONECLI_DATABASE_URL;
  delete process.env.ONECLI_URL;
  delete process.env.SECRET_ENCRYPTION_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.MYCLAW_CREDENTIAL_MODE;
});

describe('group CLI commands', () => {
  it('rejects unsupported runtime and storage settings', () => {
    const base = fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8');

    expect(() =>
      parseRuntimeSettings(
        base.replace('storage:\n', 'runtime:\n  profile: personal\nstorage:\n'),
      ),
    ).toThrow(/runtime\.profile is not supported/);

    expect(() =>
      parseRuntimeSettings(
        base.replace('storage:\n', 'storage:\n  provider: sqlite\n'),
      ),
    ).toThrow(/storage\.provider is not supported/);

    expect(() =>
      parseRuntimeSettings(
        base.replace(
          '  postgres:\n',
          '  sqlite:\n    path: ./store/myclaw.db\n  postgres:\n',
        ),
      ),
    ).toThrow(/storage\.sqlite is not supported/);

    expect(() =>
      parseRuntimeSettings(
        `${base}\ncredential_broker:\n  vault:\n    url_env: VAULT_URL\n`,
      ),
    ).toThrow(/credential_broker\.vault is not supported/);
  });

  it('defaults partial OneCLI broker persistence settings to the onecli schema', () => {
    const base = fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8');
    const settings = parseRuntimeSettings(
      `${base}\ncredential_broker:\n  onecli:\n    postgres:\n      url_env: CUSTOM_ONECLI_DATABASE_URL\n`,
    );

    expect(settings.credentialBroker.onecli.postgres).toEqual({
      urlEnv: 'CUSTOM_ONECLI_DATABASE_URL',
      schema: 'onecli',
    });
  });

  it('rejects mixed-case Postgres schema settings', () => {
    const base = fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8');

    expect(() =>
      parseRuntimeSettings(
        base.replace('    schema: myclaw', '    schema: MyClaw'),
      ),
    ).toThrow(
      /storage\.postgres\.schema must be a lowercase PostgreSQL schema identifier/,
    );

    expect(() =>
      parseRuntimeSettings(
        `${base}\ncredential_broker:\n  onecli:\n    postgres:\n      schema: OneCLI\n`,
      ),
    ).toThrow(
      /credential_broker\.onecli\.postgres\.schema must be a lowercase PostgreSQL schema identifier/,
    );
  });

  it('accepts custom lowercase embedding provider ids in settings', () => {
    const base = fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8');
    const settings = parseRuntimeSettings(
      base.replace(
        '    enabled: false\n    provider: disabled',
        '    enabled: true\n    provider: custom_provider-1',
      ),
    );

    expect(settings.memory.embeddings.provider).toBe('custom_provider-1');
  });

  it('rejects invalid embedding provider ids in settings', () => {
    const base = fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8');

    expect(() =>
      parseRuntimeSettings(
        base.replace('    provider: disabled', '    provider: CustomProvider'),
      ),
    ).toThrow(/memory\.embeddings\.provider must be a lowercase provider id/);
  });

  it('accepts custom lowercase embedding provider ids in memory snapshots', () => {
    const snapshot = parseRuntimeMemorySnapshotFromRoot({
      memory: {
        enabled: true,
        embeddings: {
          enabled: true,
          provider: 'custom_provider-1',
          model: 'custom-embedding-model',
        },
      },
    });

    expect(snapshot.embeddingProvider).toBe('custom_provider-1');
  });

  it('rejects invalid embedding provider ids in memory snapshots', () => {
    expect(() =>
      parseRuntimeMemorySnapshotFromRoot({
        memory: {
          enabled: true,
          embeddings: { provider: 'CustomProvider' },
        },
      }),
    ).toThrow(/memory\.embeddings\.provider must be a lowercase provider id/);
  });

  it('rejects runtime settings when MyClaw and OneCLI use the same database role', () => {
    process.env.ONECLI_DATABASE_URL =
      'postgres://user:pass@127.0.0.1:5432/myclaw?schema=onecli';

    const result = validateRuntimeSettings(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'must use different Postgres roles',
    );
  });

  it('rejects runtime settings when MyClaw and OneCLI use different databases', () => {
    process.env.ONECLI_DATABASE_URL =
      'postgres://onecli:pass@127.0.0.1:5432/other?schema=onecli';

    const result = validateRuntimeSettings(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'same Postgres database',
    );
  });

  it('rejects runtime settings when OneCLI database URL is missing', () => {
    delete process.env.ONECLI_DATABASE_URL;

    const result = validateRuntimeSettings(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'ONECLI_DATABASE_URL is required',
    );
  });

  it('rejects runtime settings when OneCLI URL is missing', () => {
    updateCredentialBrokerSettings({ onecliUrl: '' });

    const result = validateRuntimeSettings(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'credential_broker.onecli.url is required',
    );
  });

  it('allows none credential mode without OneCLI URL or persistence', () => {
    delete process.env.ONECLI_DATABASE_URL;
    delete process.env.SECRET_ENCRYPTION_KEY;
    updateCredentialBrokerSettings({ mode: 'none', onecliUrl: '' });

    const result = validateRuntimeSettings(runtimeHome);

    expect(result.ok).toBe(true);
  });

  it('allows external credential mode without OneCLI URL or persistence', () => {
    delete process.env.ONECLI_DATABASE_URL;
    delete process.env.SECRET_ENCRYPTION_KEY;
    updateCredentialBrokerSettings({
      mode: 'external',
      onecliUrl: '',
      externalBaseUrl: 'https://llm-proxy.example.com',
    });

    const result = validateRuntimeSettings(runtimeHome);

    expect(result.ok).toBe(true);
  });

  it('rejects runtime settings when OneCLI encryption key is weak', () => {
    process.env.SECRET_ENCRYPTION_KEY = 'short';

    const result = validateRuntimeSettings(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.details.join('\n')).toContain(
      'base64-encoded 32-byte',
    );
  });

  it('prints current channel connect commands when no agents are registered', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => undefined);

    expect(await runAgentCommand(runtimeHome, ['list'])).toBe(0);

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('myclaw provider connect telegram'),
    );
  });

  it('seeds prompt FileArtifacts when adding an agent', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const jid = `dc:soul-seed-${Date.now().toString(36)}`;
    const folder = 'telegram_soul_seed';

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Soul Seed',
        '--folder',
        folder,
      ]),
    ).toBe(0);

    expect(
      fs.existsSync(path.join(runtimeHome, 'agents', folder, 'SOUL.md')),
    ).toBe(false);
    const soul =
      fileArtifacts.get(
        `default:agent:${folder}:prompt-profile:${folder}/SOUL.md`,
      ) ?? '';
    expect(soul).toContain('# Soul - Who You Are');
    expect(soul).toContain('- **Name:** Soul Seed');
    expect(soul).toContain('## Continuity Boundary');
    expect(soul).toContain(
      'Durable facts, user preferences, task state, and open commitments do not live here.',
    );

    const groupPrompt =
      fileArtifacts.get(
        `default:agent:${folder}:prompt-profile:${folder}/CLAUDE.md`,
      ) ?? '';
    expect(groupPrompt).toContain('assistant for this conversation');
    expect(groupPrompt).toContain('Keep responses clear');
  });

  it('adds and reads a non-telegram group', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const suffix = Date.now().toString(36);
    const jid = `grp:team-room-${suffix}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Channel Team',
        '--trigger',
        '@Kai',
      ]),
    ).toBe(0);

    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    expect(await runAgentCommand(runtimeHome, ['info', jid])).toBe(0);

    const output = infoSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Name: Channel Team');
    expect(output).toContain('Trigger: @Kai');
  });

  it('does not seed Telegram control approver from recent group messages when adding an agent', async () => {
    vi.resetModules();
    vi.doMock('@core/cli/telegram.js', () => ({
      normalizeTelegramChatJid: vi.fn((value: string) => {
        const trimmed = value.trim();
        if (!/^-?\d+$/.test(trimmed)) return null;
        return `tg:${trimmed}`;
      }),
      verifyTelegramChatAccess: vi.fn(async () => ({
        ok: true,
        message: 'ok',
        chatTitle: 'Kai',
      })),
    }));
    fs.writeFileSync(
      envFilePath(runtimeHome),
      'TELEGRAM_BOT_TOKEN=telegram-token\n',
      'utf-8',
    );
    messagesStore.set('tg:-100123', [
      {
        id: 'm1',
        chat_jid: 'tg:-100123',
        sender: '5759865942',
        sender_name: 'Ravi',
        content: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
    ]);

    try {
      const { runAgentCommand } = await import('@core/cli/group.js');
      expect(
        await runAgentCommand(runtimeHome, [
          'add',
          '-100123',
          '--name',
          'Kai',
          '--folder',
          'kai_tg_100123',
          '--no-test-message',
        ]),
      ).toBe(0);

      const settings = loadRuntimeSettingsFromPath(
        settingsFilePath(runtimeHome),
      );
      const conversation = Object.values(settings.conversations).find(
        (entry) => entry.externalId === '-100123',
      );
      expect(conversation?.controlApprovers).toEqual([]);
    } finally {
      vi.doUnmock('@core/cli/telegram.js');
      vi.resetModules();
    }
  });

  it('persists the configurable default agent name', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');

    expect(await runAgentCommand(runtimeHome, ['name', 'Kai'])).toBe(0);

    const settings = loadRuntimeSettingsFromPath(settingsFilePath(runtimeHome));
    expect(settings.agent.name).toBe('Kai');
  });

  it('uses the configured default trigger for new agents', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const jid = `grp:default-trigger-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, ['add', jid, '--name', 'Defaulted']),
    ).toBe(0);

    expect(groupsStore.get(jid)?.trigger).toBe('@Default Agent');
  });

  it('updates and disables trigger mode', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const suffix = Date.now().toString(36);
    const jid = `grp:trigger-room-${suffix}`;

    await runAgentCommand(runtimeHome, [
      'add',
      jid,
      '--name',
      'Trigger Group',
      '--trigger',
      '@Andy',
    ]);

    expect(await runAgentCommand(runtimeHome, ['trigger', jid, '@Bot'])).toBe(
      0,
    );
    expect(await runAgentCommand(runtimeHome, ['trigger', jid, '--off'])).toBe(
      0,
    );

    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    expect(await runAgentCommand(runtimeHome, ['info', jid])).toBe(0);

    const output = infoSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Trigger: @Bot');
    expect(output).toContain('Requires Trigger: no');
  });

  it('rejects folder-style selectors in group add', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    expect(
      await runAgentCommand(runtimeHome, ['add', 'team_ops', '--name', 'Team']),
    ).toBe(1);
  });

  it('resolves numeric selector as folder when it exists', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const jid = `dc:numeric-folder-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Numeric Folder',
        '--folder',
        '123',
      ]),
    ).toBe(0);

    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    expect(await runAgentCommand(runtimeHome, ['info', '123'])).toBe(0);

    const output = infoSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain(`JID: ${jid}`);
    expect(output).toContain('Folder: 123');
  });

  it('requires --yes for remove in non-interactive mode', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const jid = `dc:remove-confirm-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, ['add', jid, '--name', 'To Remove']),
    ).toBe(0);

    expect(await runAgentCommand(runtimeHome, ['remove', jid])).toBe(1);
    expect(await runAgentCommand(runtimeHome, ['remove', jid, '--yes'])).toBe(
      0,
    );
    expect(await runAgentCommand(runtimeHome, ['info', jid])).toBe(1);
  });

  it('updates per-agent sender policy using folder keys', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const jid = `sl:policy-room-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Policy Group',
        '--folder',
        'slack_policy_group',
      ]),
    ).toBe(0);

    expect(
      await runAgentCommand(runtimeHome, [
        'policy',
        jid,
        '--allow',
        'U123,U456',
        '--mode',
        'drop',
      ]),
    ).toBe(0);

    const settings = parseRuntimeSettings(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    const conversation = Object.values(settings.conversations).find(
      (candidate) => candidate.externalId === jid.replace(/^sl:/, ''),
    );
    expect(conversation?.senderPolicy).toEqual({
      allow: ['U123', 'U456'],
      mode: 'drop',
    });

    expect(await runAgentCommand(runtimeHome, ['policy', jid, '--clear'])).toBe(
      0,
    );

    const updated = parseRuntimeSettings(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    const updatedConversation = Object.values(updated.conversations).find(
      (candidate) => candidate.externalId === jid.replace(/^sl:/, ''),
    );
    expect(updatedConversation?.senderPolicy).toEqual({
      allow: '*',
      mode: 'trigger',
    });
  });

  it('updates sender policy for configured provider conversations', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const jid = `sl:default-policy-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Default Policy',
        '--folder',
        'slack_default_policy',
      ]),
    ).toBe(0);

    expect(
      await runAgentCommand(runtimeHome, [
        'policy-default',
        '--channel',
        'slack',
        '--allow',
        'U333',
        '--mode',
        'drop',
      ]),
    ).toBe(0);

    const settings = parseRuntimeSettings(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    const conversation = Object.values(settings.conversations).find(
      (candidate) => candidate.externalId === jid.replace(/^sl:/, ''),
    );
    expect(conversation?.senderPolicy).toEqual({
      allow: ['U333'],
      mode: 'drop',
    });
  });

  it('prunes per-agent sender policy override when agent is removed', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const jid = `sl:remove-policy-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Remove Policy',
        '--folder',
        'slack_remove_policy',
      ]),
    ).toBe(0);

    expect(
      await runAgentCommand(runtimeHome, [
        'policy',
        jid,
        '--allow',
        'U777',
        '--mode',
        'trigger',
      ]),
    ).toBe(0);

    expect(await runAgentCommand(runtimeHome, ['remove', jid, '--yes'])).toBe(
      0,
    );

    const settings = parseRuntimeSettings(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    expect(settings.bindings.slack_remove_policy).toBeUndefined();
  });

  it('prunes only the removed conversation binding for multi-conversation agents', async () => {
    const { runAgentCommand } = await import('@core/cli/group.js');
    const suffix = Date.now().toString(36);
    const firstJid = `sl:remove-one-${suffix}`;
    const secondJid = `sl:keep-one-${suffix}`;
    const folder = 'slack_multi_remove';

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        firstJid,
        '--name',
        'Multi First',
        '--folder',
        folder,
      ]),
    ).toBe(0);
    const seeded = loadRuntimeSettingsFromPath(settingsFilePath(runtimeHome));
    ensureConfiguredConversationBinding(seeded, {
      agentId: folder,
      agentName: 'Multi First',
      agentFolder: folder,
      jid: secondJid,
      displayName: 'Multi Second',
      trigger: '@Multi',
      requiresTrigger: true,
    });
    saveRuntimeSettings(runtimeHome, seeded);

    expect(
      await runAgentCommand(runtimeHome, ['remove', firstJid, '--yes']),
    ).toBe(0);

    const settings = parseRuntimeSettings(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    const folderBindings = Object.values(settings.bindings).filter(
      (binding) => binding.agent === folder,
    );
    expect(folderBindings).toHaveLength(1);
    const remainingConversation =
      settings.conversations[folderBindings[0].conversation];
    expect(remainingConversation?.externalId).toBe(
      secondJid.replace(/^sl:/, ''),
    );
    expect(
      Object.values(settings.conversations).some(
        (conversation) =>
          conversation.externalId === firstJid.replace(/^sl:/, ''),
      ),
    ).toBe(false);
  });
});
