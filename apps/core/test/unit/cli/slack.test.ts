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

const groupsStore = vi.hoisted(() => new Map<string, any>());
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
  while (runtimeHomes.length > 0) {
    const runtimeHome = runtimeHomes.pop();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('cli slack helpers', () => {
  function makeRuntimeHome(): string {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-slack-test-'),
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

  it('seeds CLAUDE.md and SOUL.md FileArtifacts when registering the main group', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerSlackMainGroup({
      runtimeHome,
      chatJid: 'sl:C0123456789',
      displayName: 'Kai Slack',
    });

    const claude =
      fileArtifacts.get(
        `default:agent:${result.folder}:prompt-profile:${result.folder}/CLAUDE.md`,
      ) ?? '';
    const soul =
      fileArtifacts.get(
        `default:agent:${result.folder}:prompt-profile:${result.folder}/SOUL.md`,
      ) ?? '';

    expect(result.groupName).toBe('Kai Slack');
    expect(result.folder).toBe('main_agent');
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', result.folder, 'CLAUDE.md'),
      ),
    ).toBe(false);
    expect(claude).toContain('assistant for this conversation');
    expect(claude).toContain('Keep responses clear');
    expect(claude).not.toContain('capability changes');
    expect(soul).toContain('# Soul - Who You Are');
    expect(soul).toContain('- **Name:** Kai Slack');
    expect(soul).toContain('## Continuity Boundary');
  });
});
