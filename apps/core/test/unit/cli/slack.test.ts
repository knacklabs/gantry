import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeSlackChatJid,
  registerSlackMainGroup,
  validateSlackAppToken,
  validateSlackBotToken,
  verifySlackChatAccess,
} from '@core/cli/slack.js';
import { readEnvFile } from '@core/config/env/file.js';
import { envFilePath } from '@core/config/settings/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { listSlackRecentChats } from '@core/cli/slack-chat-discovery.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import {
  pruneAgentSenderPolicyOverride,
  resolveGroupSelector,
} from '@core/cli/group-helpers.js';

const groupsStore = vi.hoisted(() => new Map<string, any>());
const fileArtifacts = vi.hoisted(() => new Map<string, string>());
const fileArtifactState = vi.hoisted(() => ({ failWrites: false }));
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
      .map((key, index) => ({
        id: `file-artifact:test:${index + 1}`,
        scope: input.virtualScope,
        path: key.slice(key.lastIndexOf(':') + 1),
        version: 1,
        contentHash: `hash-${index + 1}`,
        sizeBytes: fileArtifacts.get(key)?.length ?? 0,
        contentType: 'text/markdown',
        createdAt: new Date(0).toISOString(),
      }));
  },
  async writeFileArtifact(input: any) {
    const key = `${input.appId}:${input.agentId}:${input.virtualScope}:${input.virtualPath}`;
    const agentFolder = String(input.agentId).replace(/^agent:/, '');
    const hasConversationRoute = Array.from(groupsStore.values()).some(
      (group) => group.folder === agentFolder,
    );
    if (!hasConversationRoute) {
      throw new Error(`missing conversation route for ${input.agentId}`);
    }
    if (fileArtifactState.failWrites) {
      throw new Error('profile seed failed');
    }
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
    return { artifact: {}, content };
  },
  async promoteScratch() {
    throw new Error('not used');
  },
}));
const strongEncryptionKey = Buffer.from(
  '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f',
  'hex',
).toString('base64');

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

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  groupsStore.clear();
  fileArtifacts.clear();
  fileArtifactState.failWrites = false;
  while (runtimeHomes.length > 0) {
    const runtimeHome = runtimeHomes.pop();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

function mockRuntimeSecretStorage(runtimeHome: string) {
  fs.writeFileSync(
    path.join(runtimeHome, '.env'),
    `SECRET_ENCRYPTION_KEY=${strongEncryptionKey}\n`,
  );
  const storeRuntimeSecretInput = vi.fn(async () => undefined);
  vi.doMock('@core/cli/credentials.js', () => ({
    storeRuntimeSecretInput,
  }));
  return storeRuntimeSecretInput;
}

describe('cli slack helpers', () => {
  function makeRuntimeHome(): string {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-slack-test-'),
    );
    const settings = loadRuntimeSettings(runtimeHome);
    saveRuntimeSettings(runtimeHome, settings);
    runtimeHomes.push(runtimeHome);
    return runtimeHome;
  }

  it('normalizes valid Slack chat ids', () => {
    expect(normalizeSlackChatJid('C0123456789')).toBe('sl:C0123456789');
    expect(normalizeSlackChatJid('sl:g0123456789')).toBe('sl:G0123456789');
    expect(normalizeSlackChatJid(' d12345678 ')).toBe('sl:D12345678');
  });

  it('rejects invalid Slack chat ids', () => {
    expect(normalizeSlackChatJid('')).toBeNull();
    expect(normalizeSlackChatJid('abc')).toBeNull();
    expect(normalizeSlackChatJid('sl:bad id')).toBeNull();
  });

  it('resolves a bare Slack JID to one agent-qualified route', () => {
    const routeKey = makeAgentThreadQueueKey(
      'sl:C0123456789',
      'agent:main_agent',
    );
    const group = {
      name: 'Kai Slack',
      folder: 'main_agent',
      trigger: '',
      added_at: '2026-04-24T00:00:00.000Z',
      requiresTrigger: false,
    };

    expect(
      resolveGroupSelector({ [routeKey]: group }, 'sl:C0123456789'),
    ).toEqual({
      found: { jid: routeKey, group },
    });
  });

  it('validates Slack bot token with auth.test', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          team: 'My Workspace',
          team_id: 'T123',
          user_id: 'U123',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateSlackBotToken('xoxb-valid-token');

    expect(result.ok).toBe(true);
    expect(result.teamId).toBe('T123');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not leak token-bearing Slack bot validation transport errors', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(
        new Error('request failed with authorization Bearer xoxb-secret-token'),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateSlackBotToken('xoxb-secret-token');

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('xoxb-secret-token');
    expect(result.nextAction).not.toContain('Bearer');
  });

  it('rejects non-xapp app token prefix immediately', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateSlackAppToken('xoxb-not-app-token');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('must start with xapp-');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not leak token-bearing Slack app validation transport errors', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(
        new Error('request failed with authorization Bearer xapp-secret-token'),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateSlackAppToken('xapp-secret-token');

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('xapp-secret-token');
    expect(result.nextAction).not.toContain('Bearer');
  });

  it('verifies chat access and sends a test message', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            channel: { id: 'C0123456789', name: 'ops-room' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            ts: '1710000000.000100',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifySlackChatAccess({
      botToken: 'xoxb-valid-token',
      chatJid: 'sl:C0123456789',
      sendTestMessage: true,
    });

    expect(result.ok).toBe(true);
    expect(result.chatTitle).toBe('ops-room');
    expect(result.sentTestMessage).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not echo token-bearing HTTP error bodies from Slack chat verification', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'proxy echoed authorization Bearer xoxb-secret-token for conversations.info',
          { status: 502 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifySlackChatAccess({
      botToken: 'xoxb-secret-token',
      chatJid: 'sl:C0123456789',
    });

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('xoxb-secret-token');
    expect(result.nextAction).not.toContain('Bearer');
  });

  it('sanitizes unsafe Slack API error strings before printing them', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'Bearer xoxb-secret-token',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifySlackChatAccess({
      botToken: 'xoxb-secret-token',
      chatJid: 'sl:C0123456789',
    });

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('xoxb-secret-token');
    expect(result.message).not.toContain('Bearer');
    expect(result.message).toContain('unknown_error');
  });

  it('discovers recent Slack conversations for setup selection', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          channels: [
            {
              id: 'C0123456789',
              name: 'ops-room',
              is_private: false,
              latest: { ts: '1710000001.000100' },
            },
            {
              id: 'G0123456789',
              name: 'leadership',
              is_private: true,
              latest: { ts: '1710000000.000100' },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listSlackRecentChats({
      botToken: 'xoxb-valid-token',
      limit: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.chats).toHaveLength(2);
    expect(result.chats[0]?.chatJid).toBe('sl:C0123456789');
    expect(result.chats[0]?.chatTitle).toBe('ops-room');
  });

  it('does not echo token-bearing HTTP error bodies from Slack discovery', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'proxy echoed authorization Bearer xoxb-secret-token for users.conversations',
          { status: 502 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listSlackRecentChats({
      botToken: 'xoxb-secret-token',
      limit: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('xoxb-secret-token');
    expect(result.nextAction).not.toContain('Bearer');
  });

  it('does not leak token-bearing Slack transport errors', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(
        new Error('request failed with authorization Bearer xoxb-secret-token'),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listSlackRecentChats({
      botToken: 'xoxb-secret-token',
      limit: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('xoxb-secret-token');
    expect(result.nextAction).not.toContain('Bearer');
  });

  it('sanitizes token-bearing Slack JSON discovery errors', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'invalid_auth Bearer xoxb-secret-token',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listSlackRecentChats({
      botToken: 'xoxb-secret-token',
      limit: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Slack conversation discovery failed: unknown_error.',
    );
    expect(result.message).not.toContain('xoxb-secret-token');
    expect(result.message).not.toContain('Bearer');
  });

  it('slack chat selection asks for confirmation even with one discovered chat', async () => {
    vi.resetModules();
    const select = vi.fn(async () => 'skip');
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      select,
      text: vi.fn(),
      log: {
        info: vi.fn(),
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }));
    vi.doMock('@core/cli/slack-chat-discovery.js', () => ({
      listSlackRecentChats: vi.fn(async () => ({
        ok: true,
        message: 'Discovered 1 Slack conversation.',
        chats: [
          {
            chatJid: 'sl:C0123456789',
            chatTitle: 'ops-room',
            chatType: 'channel',
          },
        ],
      })),
    }));

    const { chooseSlackChatForConnect } =
      await import('@core/cli/slack-connect-chat-picker.js');
    const result = await chooseSlackChatForConnect('xoxb-secret-token');

    expect(result).toEqual({ type: 'skip' });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Choose the Slack conversation for the Default Agent',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'sl:C0123456789' }),
          expect.objectContaining({ value: 'manual' }),
          expect.objectContaining({ value: 'skip' }),
        ]),
      }),
    );
  });

  it('slack connect cancel after token validation does not persist credentials', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const outro = vi.fn();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            team: 'My Workspace',
            team_id: 'T123',
            user_id: 'U123',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            url: 'wss://example.slack.test/socket',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi
        .fn()
        .mockResolvedValueOnce('xoxb-valid-token')
        .mockResolvedValueOnce('xapp-valid-token'),
      select: vi.fn(async () => 'gantry'),
      text: vi.fn(),
      outro,
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
    }));
    vi.doMock('@core/cli/slack-connect-chat-picker.js', () => ({
      chooseSlackChatForConnect: vi.fn(async () => ({ type: 'cancel' })),
    }));
    mockRuntimeSecretStorage(runtimeHome);

    const { runSlackConnectCommand } = await import('@core/cli/slack.js');
    const code = await runSlackConnectCommand(runtimeHome);

    expect(code).toBe(1);
    const env = readEnvFile(envFilePath(runtimeHome));
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.SLACK_APP_TOKEN).toBeUndefined();
    expect(loadRuntimeSettings(runtimeHome).providers.slack.enabled).toBe(
      false,
    );
    expect(outro).toHaveBeenCalledWith('Slack connect cancelled.');
  });

  it('slack connect preserves the verified conversation display name and approvers', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            team: 'My Workspace',
            team_id: 'T123',
            user_id: 'U123',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            url: 'wss://example.slack.test/socket',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            channel: { id: 'C0123456789', name: 'ops-room' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi
        .fn()
        .mockResolvedValueOnce('xoxb-valid-token')
        .mockResolvedValueOnce('xapp-valid-token'),
      select: vi.fn(async () => 'gantry'),
      text: vi.fn().mockResolvedValueOnce('U123'),
      outro: vi.fn(),
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
    }));
    vi.doMock('@core/cli/slack-connect-chat-picker.js', () => ({
      chooseSlackChatForConnect: vi.fn(async () => ({
        type: 'selected',
        chatJid: 'sl:C0123456789',
      })),
    }));
    const storeRuntimeSecretInput = mockRuntimeSecretStorage(runtimeHome);

    const { runSlackConnectCommand } = await import('@core/cli/slack.js');
    const code = await runSlackConnectCommand(runtimeHome);

    expect(code).toBe(0);
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'SLACK_BOT_TOKEN',
      value: 'xoxb-valid-token',
      actor: 'cli:slack-connect',
    });
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'SLACK_APP_TOKEN',
      value: 'xapp-valid-token',
      actor: 'cli:slack-connect',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.conversations?.slack_default_c0123456789).toEqual(
      expect.objectContaining({
        displayName: 'ops-room',
        providerConnection: 'slack_default',
        externalId: 'C0123456789',
        controlApprovers: ['U123'],
        senderPolicy: { allow: '*', mode: 'trigger' },
      }),
    );
  });

  it('slack connect stores secrets on the selected agent provider account', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    groupsStore.set('sl:C0123456789', {
      name: 'Recruiting',
      folder: 'recruiting_agent',
      trigger: '@Recruiting',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: true,
    });
    const seedSettings = loadRuntimeSettings(runtimeHome);
    seedSettings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    seedSettings.agents.recruiting_agent = {
      name: 'Recruiting',
      folder: 'recruiting_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    seedSettings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Main Slack',
      runtimeSecretRefs: { bot_token: 'gantry-secret:MAIN_BOT' },
    };
    seedSettings.providerAccounts.slack_recruiting_agent = {
      agentId: 'recruiting_agent',
      provider: 'slack',
      label: 'Recruiting Slack',
      runtimeSecretRefs: { bot_token: 'gantry-secret:OLD_BOT' },
    };
    saveRuntimeSettings(runtimeHome, seedSettings);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, team: 'Team', user_id: 'U123' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, url: 'wss://example.slack.test' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              channel: { id: 'C0123456789', name: 'recruiting' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    );
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi
        .fn()
        .mockResolvedValueOnce('xoxb-new-token')
        .mockResolvedValueOnce('xapp-new-token'),
      select: vi.fn(async () => 'gantry'),
      text: vi.fn().mockResolvedValueOnce('U123'),
      outro: vi.fn(),
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
    }));
    vi.doMock('@core/cli/slack-connect-chat-picker.js', () => ({
      chooseSlackChatForConnect: vi.fn(async () => ({
        type: 'selected',
        chatJid: 'sl:C0123456789',
      })),
    }));
    mockRuntimeSecretStorage(runtimeHome);

    const { runSlackConnectCommand } = await import('@core/cli/slack.js');
    const code = await runSlackConnectCommand(runtimeHome);

    expect(code).toBe(0);
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.providerAccounts.slack_default.runtimeSecretRefs).toEqual({
      bot_token: 'gantry-secret:MAIN_BOT',
    });
    expect(
      settings.providerAccounts.slack_recruiting_agent.runtimeSecretRefs,
    ).toEqual({
      bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
      app_token: 'gantry-secret:SLACK_APP_TOKEN',
    });
    expect(
      settings.conversations.slack_recruiting_agent_c0123456789.providerAccount,
    ).toBe('slack_recruiting_agent');
  });

  it('seeds AGENTS.md and SOUL.md FileArtifacts when registering the main group', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerSlackMainGroup({
      runtimeHome,
      chatJid: 'sl:C0123456789',
      displayName: 'Kai Slack',
      conversationDisplayName: 'recruiting-demo',
      approverIds: ['U123'],
    });

    const claude =
      fileArtifacts.get(
        `default:agent:${result.folder}:prompt-profile:${result.folder}/AGENTS.md`,
      ) ?? '';
    const soul =
      fileArtifacts.get(
        `default:agent:${result.folder}:prompt-profile:${result.folder}/SOUL.md`,
      ) ?? '';

    expect(result.groupName).toBe('Kai Slack');
    expect(result.folder).toBe('main_agent');
    expect(groupsStore.get('sl:C0123456789')).toEqual(
      expect.objectContaining({
        name: 'Kai Slack',
        folder: 'main_agent',
        requiresTrigger: true,
      }),
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.conversations?.slack_default_c0123456789).toEqual(
      expect.objectContaining({
        displayName: 'recruiting-demo',
        providerConnection: 'slack_default',
        externalId: 'C0123456789',
        controlApprovers: ['U123'],
        senderPolicy: { allow: '*', mode: 'trigger' },
      }),
    );
    expect(settings.providerAccounts?.slack_default).toEqual(
      expect.objectContaining({
        provider: 'slack',
      }),
    );
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', result.folder, 'CLAUDE.md'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', result.folder, 'AGENTS.md'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', result.folder, 'AGENTS.profile.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(runtimeHome, 'agents', result.folder, 'SOUL.md')),
    ).toBe(true);
    expect(claude).toContain('agent for this conversation');
    expect(claude).toContain('Keep responses clear');
    expect(claude).not.toContain('capability changes');
    expect(soul).toContain('# Soul - Who You Are');
    expect(soul).toContain('- **Name:** Kai Slack');
    expect(soul).toContain('## Continuity Boundary');
  });

  it('keeps desired Slack settings when prompt profile seeding fails', async () => {
    const runtimeHome = makeRuntimeHome();
    fileArtifactState.failWrites = true;

    await expect(
      registerSlackMainGroup({
        runtimeHome,
        chatJid: 'sl:C0123456789',
        displayName: 'Kai Slack',
        conversationDisplayName: 'recruiting-demo',
        approverIds: ['U123'],
      }),
    ).rejects.toThrow('profile seed failed');

    expect(groupsStore.get('sl:C0123456789')).toEqual(
      expect.objectContaining({
        name: 'Kai Slack',
        folder: 'main_agent',
        requiresTrigger: true,
      }),
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.conversations?.slack_default_c0123456789).toEqual(
      expect.objectContaining({
        displayName: 'recruiting-demo',
        providerConnection: 'slack_default',
        externalId: 'C0123456789',
        controlApprovers: ['U123'],
        senderPolicy: { allow: '*', mode: 'trigger' },
      }),
    );
  });

  it('persists trigger requirement changes into Slack desired settings', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerSlackMainGroup({
      runtimeHome,
      chatJid: 'sl:C0123456789',
      displayName: 'Kai Slack',
      conversationDisplayName: 'recruiting-demo',
      approverIds: ['U123'],
    });

    groupsStore.set('sl:C0123456789', {
      ...groupsStore.get('sl:C0123456789'),
      requiresTrigger: false,
    });
    const staleSettings = loadRuntimeSettings(runtimeHome);
    const bindingId = Object.entries(staleSettings.bindings).find(
      ([, binding]) => binding.agent === result.folder,
    )?.[0];
    expect(bindingId).toBeTruthy();
    staleSettings.bindings[bindingId!].requiresTrigger = false;
    staleSettings.agents[result.folder].bindings[bindingId!].requiresTrigger =
      false;
    saveRuntimeSettings(runtimeHome, staleSettings);

    const { runAgentCommand } = await import('@core/cli/group.js');
    const code = await runAgentCommand(runtimeHome, [
      'trigger',
      'sl:C0123456789',
      '@reagent',
    ]);

    expect(code).toBe(0);
    expect(groupsStore.get('sl:C0123456789')).toEqual(
      expect.objectContaining({ requiresTrigger: true }),
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.bindings[bindingId!]).toEqual(
      expect.objectContaining({
        trigger: '@reagent',
        requiresTrigger: true,
      }),
    );
    expect(settings.agents[result.folder].bindings[bindingId!]).toEqual(
      expect.objectContaining({
        trigger: '@reagent',
        requiresTrigger: true,
      }),
    );
    expect(settings.conversations.slack_default_c0123456789.displayName).toBe(
      'recruiting-demo',
    );
  });

  it('updates desired settings when the selected route key is agent-qualified', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerSlackMainGroup({
      runtimeHome,
      chatJid: 'sl:C0123456789',
      displayName: 'Kai Slack',
      conversationDisplayName: 'recruiting-demo',
      approverIds: ['U123'],
    });

    const routeKey = makeAgentThreadQueueKey(
      'sl:C0123456789',
      'agent:main_agent',
    );
    const sourceRoute = groupsStore.get('sl:C0123456789');
    expect(sourceRoute).toEqual(
      expect.objectContaining({
        name: 'Kai Slack',
        folder: 'main_agent',
      }),
    );
    groupsStore.set(routeKey, { ...sourceRoute, requiresTrigger: true });

    const staleSettings = loadRuntimeSettings(runtimeHome);
    const bindingId = Object.entries(staleSettings.bindings).find(
      ([, binding]) => binding.agent === result.folder,
    )?.[0];
    expect(bindingId).toBeTruthy();

    const { runAgentCommand } = await import('@core/cli/group.js');
    const code = await runAgentCommand(runtimeHome, [
      'trigger',
      routeKey,
      '@reagent',
    ]);

    expect(code).toBe(0);
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.bindings[bindingId!]).toMatchObject({
      trigger: '@reagent',
      requiresTrigger: true,
    });
    expect(settings.agents[result.folder].bindings[bindingId!]).toMatchObject({
      trigger: '@reagent',
      requiresTrigger: true,
    });
    expect(groupsStore.get(routeKey)).toMatchObject({
      trigger: '@reagent',
      requiresTrigger: true,
    });
    expect(Object.values(settings.conversations)).not.toContainEqual(
      expect.objectContaining({
        externalId: expect.stringContaining('::agent:'),
      }),
    );
  });

  it('updates sender policy without storing agent-qualified route keys in settings', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerSlackMainGroup({
      runtimeHome,
      chatJid: 'sl:C0123456789',
      displayName: 'Kai Slack',
      conversationDisplayName: 'recruiting-demo',
      approverIds: ['U123'],
    });

    const routeKey = makeAgentThreadQueueKey(
      'sl:C0123456789',
      'agent:main_agent',
    );
    const sourceRoute = groupsStore.get('sl:C0123456789');
    groupsStore.set(routeKey, { ...sourceRoute, requiresTrigger: true });

    const { runAgentCommand } = await import('@core/cli/group.js');
    const code = await runAgentCommand(runtimeHome, [
      'policy',
      routeKey,
      '--allow',
      'U123,U456',
      '--mode',
      'drop',
    ]);

    expect(code).toBe(0);
    const settings = loadRuntimeSettings(runtimeHome);
    const bindingId = Object.entries(settings.bindings).find(
      ([, binding]) => binding.agent === result.folder,
    )?.[0];
    expect(bindingId).toBeTruthy();
    expect(settings.agents[result.folder].bindings[bindingId!].jid).toBe(
      'sl:C0123456789',
    );
    expect(
      settings.conversations.slack_default_c0123456789.senderPolicy,
    ).toEqual({ allow: ['U123', 'U456'], mode: 'drop' });
    expect(Object.values(settings.conversations)).not.toContainEqual(
      expect.objectContaining({
        externalId: expect.stringContaining('::agent:'),
      }),
    );
  });

  it('removes desired settings for an agent-qualified route key', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerSlackMainGroup({
      runtimeHome,
      chatJid: 'sl:C0123456789',
      displayName: 'Kai Slack',
      conversationDisplayName: 'recruiting-demo',
      approverIds: ['U123'],
    });

    const routeKey = makeAgentThreadQueueKey(
      'sl:C0123456789',
      'agent:main_agent',
    );
    const sourceRoute = groupsStore.get('sl:C0123456789');
    groupsStore.set(routeKey, { ...sourceRoute, requiresTrigger: true });

    const { runAgentCommand } = await import('@core/cli/group.js');
    const code = await runAgentCommand(runtimeHome, [
      'remove',
      routeKey,
      '--yes',
    ]);

    expect(code).toBe(0);
    expect(groupsStore.has(routeKey)).toBe(false);
    const settings = loadRuntimeSettings(runtimeHome);
    expect(
      Object.values(settings.bindings).some(
        (binding) => binding.agent === result.folder,
      ),
    ).toBe(false);
    expect(settings.agents[result.folder]?.bindings ?? {}).toEqual({});
  });

  it('removes only the matching installed agent from shared conversations', async () => {
    const runtimeHome = makeRuntimeHome();
    const settings = loadRuntimeSettings(runtimeHome);
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack',
      runtimeSecretRefs: {},
    };
    settings.providerAccounts.slack_researcher = {
      agentId: 'researcher',
      provider: 'slack',
      label: 'Researcher Slack',
      runtimeSecretRefs: {},
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        main_binding: {
          jid: 'sl:C0123456789',
          provider: 'slack',
          providerAccountId: 'slack_default',
          name: 'Recruiting',
          trigger: '',
          addedAt: '2026-01-01T00:00:00.000Z',
          requiresTrigger: false,
        },
      },
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.agents.researcher = {
      name: 'Researcher',
      folder: 'researcher',
      bindings: {
        researcher_binding: {
          jid: 'sl:C0123456789',
          provider: 'slack',
          providerAccountId: 'slack_researcher',
          name: 'Recruiting',
          trigger: '@researcher',
          addedAt: '2026-01-01T00:00:00.000Z',
          requiresTrigger: true,
        },
      },
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.conversations.slack_default_c0123456789 = {
      providerAccount: 'slack_default',
      externalId: 'C0123456789',
      kind: 'channel',
      displayName: 'Recruiting',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'slack_default',
          status: 'active',
          addedAt: '2026-01-01T00:00:00.000Z',
          memoryScope: 'conversation',
          trigger: '',
          requiresTrigger: false,
        },
        researcher: {
          agentId: 'researcher',
          providerAccountId: 'slack_researcher',
          status: 'active',
          addedAt: '2026-01-01T00:00:00.000Z',
          memoryScope: 'conversation',
          trigger: '@researcher',
          requiresTrigger: true,
        },
      },
    };
    settings.bindings.main_binding = {
      agent: 'main_agent',
      conversation: 'slack_default_c0123456789',
      installKey: 'main_agent',
      trigger: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'conversation',
    };
    settings.bindings.researcher_binding = {
      agent: 'researcher',
      conversation: 'slack_default_c0123456789',
      installKey: 'researcher',
      trigger: '@researcher',
      addedAt: '2026-01-01T00:00:00.000Z',
      requiresTrigger: true,
      memoryScope: 'conversation',
    };
    saveRuntimeSettings(runtimeHome, settings);

    await expect(
      pruneAgentSenderPolicyOverride(
        runtimeHome,
        'sl:C0123456789',
        'main_agent',
      ),
    ).resolves.toEqual({ pruned: true });

    const updated = loadRuntimeSettings(runtimeHome);
    expect(updated.conversations.slack_default_c0123456789).toBeDefined();
    expect(
      updated.conversations.slack_default_c0123456789.installedAgents,
    ).toEqual({
      researcher: expect.objectContaining({ agentId: 'researcher' }),
    });
    expect(Object.values(updated.bindings)).toEqual([
      expect.objectContaining({ agent: 'researcher' }),
    ]);
    expect(updated.agents.main_agent.bindings).toEqual({});
  });
});
