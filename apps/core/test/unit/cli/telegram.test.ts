import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';

import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import {
  normalizeTelegramChatJid,
  registerTelegramMainGroup,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from '@core/cli/telegram.js';
import { listTelegramRecentChats } from '@core/cli/telegram-chat-discovery.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { resolveGroupSelector } from '@core/cli/group-helpers.js';

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

describe('cli telegram helpers', () => {
  function makeRuntimeHome(): string {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-telegram-test-'),
    );
    const settings = loadRuntimeSettings(runtimeHome);
    saveRuntimeSettings(runtimeHome, settings);
    runtimeHomes.push(runtimeHome);
    return runtimeHome;
  }

  it('normalizes valid numeric chat ids', () => {
    expect(normalizeTelegramChatJid('-100123')).toBe('tg:-100123');
    expect(normalizeTelegramChatJid('tg:-100123')).toBe('tg:-100123');
    expect(normalizeTelegramChatJid(' 12345 ')).toBe('tg:12345');
  });

  it('rejects invalid chat ids', () => {
    expect(normalizeTelegramChatJid('')).toBeNull();
    expect(normalizeTelegramChatJid('abc')).toBeNull();
    expect(normalizeTelegramChatJid('tg:abc')).toBeNull();
  });

  it('verifies chat access and sends a test message', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: -100123, title: 'Team Ops' },
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
            result: { status: 'administrator' },
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
            result: { message_id: 42 },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyTelegramChatAccess({
      token: 'token',
      chatJid: 'tg:-100123',
      botId: 12345,
      sendTestMessage: true,
    });

    expect(result.ok).toBe(true);
    expect(result.chatTitle).toBe('Team Ops');
    expect(result.sentTestMessage).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const [firstCall, secondCall, thirdCall] = fetchSpy.mock.calls;
    const firstSignal = (firstCall[1] as RequestInit).signal;
    const secondSignal = (secondCall[1] as RequestInit).signal;
    const thirdSignal = (thirdCall[1] as RequestInit).signal;
    expect(firstSignal).toBeDefined();
    expect(secondSignal).toBeDefined();
    expect(thirdSignal).toBeDefined();
    expect(firstSignal).not.toBe(secondSignal);
    expect(secondSignal).not.toBe(thirdSignal);
    expect(firstSignal).not.toBe(thirdSignal);
  });

  it('fails for invalid chat format before hitting API', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyTelegramChatAccess({
      token: 'token',
      chatJid: 'invalid-chat',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not send a test message unless explicitly enabled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: -100123, title: 'Team Ops' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyTelegramChatAccess({
      token: 'token',
      chatJid: 'tg:-100123',
    });

    expect(result.ok).toBe(true);
    expect(result.sentTestMessage).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not echo token-bearing HTTP error bodies from token validation', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'proxy echoed https://api.telegram.org/botsecret-token/getMe',
          { status: 502 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateTelegramBotToken('secret-token');

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('secret-token');
    expect(result.nextAction).not.toContain('api.telegram.org/bot');
  });

  it('does not leak token-bearing token validation transport errors', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'request failed for https://api.telegram.org/botsecret-token/getMe',
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateTelegramBotToken('secret-token');

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('secret-token');
    expect(result.nextAction).not.toContain('api.telegram.org/bot');
  });

  it('sanitizes unsafe Telegram API descriptions before printing them', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description:
            'request failed for https://api.telegram.org/botsecret-token/getMe',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateTelegramBotToken('secret-token');

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('secret-token');
    expect(result.message).not.toContain('api.telegram.org/bot');
    expect(result.message).toBe('Telegram rejected this token.');
  });

  it('keeps known-safe Telegram API descriptions for doctor guidance', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description: 'Unauthorized',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateTelegramBotToken('secret-token');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Unauthorized');
  });

  it('does not echo token-bearing HTTP error bodies from chat verification', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'proxy echoed https://api.telegram.org/botsecret-token/getChat',
          { status: 502 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyTelegramChatAccess({
      token: 'secret-token',
      chatJid: 'tg:-100123',
    });

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('secret-token');
    expect(result.nextAction).not.toContain('api.telegram.org/bot');
  });

  it('does not leak token-bearing chat verification transport errors', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'request failed for https://api.telegram.org/botsecret-token/getChat',
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyTelegramChatAccess({
      token: 'secret-token',
      chatJid: 'tg:-100123',
    });

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('secret-token');
    expect(result.nextAction).not.toContain('api.telegram.org/bot');
  });

  it('discovers recent Telegram chats from bot updates', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 101,
              message: {
                chat: { id: -100123, type: 'supergroup', title: 'Kai Squad' },
                from: {
                  id: 5759865942,
                  username: 'ravi',
                  first_name: 'Ravi',
                  is_bot: false,
                },
              },
            },
            {
              update_id: 102,
              message: {
                chat: { id: 99887766, type: 'private', first_name: 'Ravi' },
                from: { id: 5759865942, first_name: 'Ravi', is_bot: false },
              },
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

    const result = await listTelegramRecentChats({ token: 'token', limit: 20 });
    expect(result.ok).toBe(true);
    expect(result.chats).toHaveLength(2);
    expect(result.chats[0]?.chatJid).toBe('tg:99887766');
    expect(result.chats[0]?.lastSenderId).toBe('5759865942');
    expect(result.chats[0]?.lastSenderName).toBe('Ravi');
    expect(result.chats[1]?.chatJid).toBe('tg:-100123');
    expect(result.chats[1]?.lastSenderId).toBe('5759865942');
    expect(result.chats[1]?.lastSenderName).toBe('Ravi');
  });

  it('does not leak token-bearing transport details when discovery fails', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'request failed for https://api.telegram.org/botsecret-token/getUpdates',
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listTelegramRecentChats({
      token: 'secret-token',
      limit: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('secret-token');
    expect(result.nextAction).not.toContain('api.telegram.org/bot');
  });

  it('does not echo token-bearing HTTP error bodies from discovery', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'proxy echoed https://api.telegram.org/botsecret-token/getUpdates',
          { status: 502 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listTelegramRecentChats({
      token: 'secret-token',
      limit: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.nextAction).not.toContain('secret-token');
    expect(result.nextAction).not.toContain('api.telegram.org/bot');
  });

  it('sanitizes token-bearing Telegram JSON discovery descriptions', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description:
            'Bad Request: proxy echoed https://api.telegram.org/botsecret-token/getUpdates',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listTelegramRecentChats({
      token: 'secret-token',
      limit: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Telegram did not return update history.');
    expect(result.message).not.toContain('secret-token');
    expect(result.message).not.toContain('api.telegram.org/bot');
  });

  it('telegram connect saves token when chat registration is skipped', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const outro = vi.fn();
    const text = vi.fn(async () => '');
    const storeRuntimeSecretInput = mockRuntimeSecretStorage(runtimeHome);

    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi.fn(async () => 'telegram-token'),
      select: vi.fn(async () => 'gantry'),
      text,
      outro,
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }));
    vi.doMock('@core/cli/telegram-chat-discovery.js', () => ({
      listTelegramRecentChats: vi.fn(async () => ({
        ok: true,
        message: 'No recent chats found in bot updates.',
        chats: [],
        nextAction: 'Send a message and retry.',
      })),
    }));
    vi.doMock('@core/cli/telegram.js', () => ({
      normalizeTelegramChatJid: vi.fn((value: string) =>
        value.trim() ? `tg:${value.trim()}` : null,
      ),
      readTelegramFromRuntimeEnv: vi.fn(() => ({ token: '' })),
      registerTelegramMainGroup: vi.fn(),
      validateTelegramBotToken: vi.fn(async () => ({
        ok: true,
        message: 'ok',
        botId: 123,
      })),
      verifyTelegramChatAccess: vi.fn(),
    }));

    const { runTelegramConnectCommand } =
      await import('@core/cli/telegram-connect.js');
    const code = await runTelegramConnectCommand(runtimeHome);

    expect(code).toBe(0);
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'TELEGRAM_BOT_TOKEN',
      value: 'telegram-token',
      actor: 'cli:telegram-connect',
    });
    expect(loadRuntimeSettings(runtimeHome).providers.telegram.enabled).toBe(
      true,
    );
    expect(outro).toHaveBeenCalledWith(
      'Telegram connected. Secret stored encrypted in Gantry. Next: run `gantry provider connect telegram` to register a conversation.',
    );
    expect(text).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Telegram chat ID (optional, e.g. -1001234567890)',
      }),
    );
  });

  it('telegram connect asks for confirmation even with one discovered chat', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const select = vi.fn(async () => 'skip');
    const storeRuntimeSecretInput = mockRuntimeSecretStorage(runtimeHome);

    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi.fn(async () => 'telegram-token'),
      select,
      text: vi.fn(),
      outro: vi.fn(),
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }));
    vi.doMock('@core/cli/telegram-chat-discovery.js', () => ({
      listTelegramRecentChats: vi.fn(async () => ({
        ok: true,
        message: 'Discovered 1 Telegram chat.',
        chats: [
          {
            chatJid: 'tg:-100123',
            chatTitle: 'Ops Room',
            chatType: 'supergroup',
          },
        ],
      })),
    }));
    vi.doMock('@core/cli/telegram.js', () => ({
      normalizeTelegramChatJid: vi.fn((value: string) =>
        value.trim() ? `tg:${value.trim()}` : null,
      ),
      readTelegramFromRuntimeEnv: vi.fn(() => ({ token: '' })),
      registerTelegramMainGroup: vi.fn(),
      validateTelegramBotToken: vi.fn(async () => ({
        ok: true,
        message: 'ok',
        botId: 123,
      })),
      verifyTelegramChatAccess: vi.fn(),
    }));

    const { runTelegramConnectCommand } =
      await import('@core/cli/telegram-connect.js');
    const code = await runTelegramConnectCommand(runtimeHome);

    expect(code).toBe(0);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Choose the Telegram chat for the Default Agent',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'tg:-100123' }),
          expect.objectContaining({ value: 'manual' }),
          expect.objectContaining({ value: 'skip' }),
        ]),
      }),
    );
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'TELEGRAM_BOT_TOKEN',
      value: 'telegram-token',
      actor: 'cli:telegram-connect',
    });
  });

  it('telegram connect enables session admin commands for an explicitly entered sender', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const select = vi.fn(async () => 'tg:-100123');
    const text = vi.fn(async () => '5759865942');
    mockRuntimeSecretStorage(runtimeHome);

    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi.fn(async () => 'telegram-token'),
      select,
      text,
      outro: vi.fn(),
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }));
    vi.doMock('@core/cli/telegram-chat-discovery.js', () => ({
      listTelegramRecentChats: vi.fn(async () => ({
        ok: true,
        message: 'Discovered 1 Telegram chat.',
        chats: [
          {
            chatJid: 'tg:-100123',
            chatTitle: 'Ops Room',
            chatType: 'supergroup',
          },
        ],
      })),
    }));
    vi.doMock('@core/cli/telegram.js', () => ({
      normalizeTelegramChatJid: vi.fn((value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.startsWith('tg:') ? trimmed : `tg:${trimmed}`;
      }),
      readTelegramFromRuntimeEnv: vi.fn(() => ({ token: '' })),
      registerTelegramMainGroup: vi.fn(async () => ({
        groupName: 'Default Agent',
        folder: 'main_agent',
      })),
      validateTelegramBotToken: vi.fn(async () => ({
        ok: true,
        message: 'ok',
        botId: 123,
      })),
      verifyTelegramChatAccess: vi.fn(async () => ({
        ok: true,
        message: 'ok',
        chatTitle: 'Ops Room',
      })),
    }));

    const { runTelegramConnectCommand } =
      await import('@core/cli/telegram-connect.js');
    const code = await runTelegramConnectCommand(runtimeHome);

    expect(code).toBe(0);
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.providers.telegram.enabled).toBe(true);
    const conversation = Object.values(settings.conversations).find(
      (entry) => entry.providerConnection === 'telegram_default',
    );
    expect(conversation?.senderPolicy.allow).toBe('*');
    expect(conversation?.controlApprovers).toEqual(['5759865942']);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Telegram sender/user ID for session admin (optional)',
      }),
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Telegram approver user IDs for permissions; seeds conversation approvers (required)',
      }),
    );
  });

  it('telegram connect stores approvers when a discovered chat has no admin sender default', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const select = vi.fn(async () => 'tg:-100123');
    const text = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('5759865942');
    mockRuntimeSecretStorage(runtimeHome);

    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi.fn(async () => 'telegram-token'),
      select,
      text,
      outro: vi.fn(),
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }));
    vi.doMock('@core/cli/telegram-chat-discovery.js', () => ({
      listTelegramRecentChats: vi.fn(async () => ({
        ok: true,
        message: 'Discovered 1 Telegram chat.',
        chats: [
          {
            chatJid: 'tg:-100123',
            chatTitle: 'Ops Room',
            chatType: 'supergroup',
          },
        ],
      })),
    }));
    vi.doMock('@core/cli/telegram.js', () => ({
      normalizeTelegramChatJid: vi.fn((value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.startsWith('tg:') ? trimmed : `tg:${trimmed}`;
      }),
      readTelegramFromRuntimeEnv: vi.fn(() => ({ token: '' })),
      registerTelegramMainGroup: vi.fn(async () => ({
        groupName: 'Default Agent',
        folder: 'main_agent',
      })),
      validateTelegramBotToken: vi.fn(async () => ({
        ok: true,
        message: 'ok',
        botId: 123,
      })),
      verifyTelegramChatAccess: vi.fn(async () => ({
        ok: true,
        message: 'ok',
        chatTitle: 'Ops Room',
      })),
    }));

    const { runTelegramConnectCommand } =
      await import('@core/cli/telegram-connect.js');
    const code = await runTelegramConnectCommand(runtimeHome);

    expect(code).toBe(0);
    const conversation = Object.values(
      loadRuntimeSettings(runtimeHome).conversations,
    ).find((entry) => entry.providerConnection === 'telegram_default');
    expect(conversation?.controlApprovers).toEqual(['5759865942']);
    expect(text).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: 'Telegram sender/user ID for session admin (optional)',
      }),
    );
    expect(text).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message:
          'Telegram approver user IDs for permissions; seeds conversation approvers (required)',
        defaultValue: '',
      }),
    );
  });

  it('seeds AGENTS.md and SOUL.md FileArtifacts when registering the main group', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerTelegramMainGroup({
      runtimeHome,
      chatJid: 'tg:-100123',
      displayName: 'Kai Telegram',
    });

    const claude =
      fileArtifacts.get(
        `default:agent:${result.folder}:prompt-profile:${result.folder}/AGENTS.md`,
      ) ?? '';
    const soul =
      fileArtifacts.get(
        `default:agent:${result.folder}:prompt-profile:${result.folder}/SOUL.md`,
      ) ?? '';

    expect(result.groupName).toBe('Kai Telegram');
    expect(result.folder).toBe('main_agent');
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
    expect(soul).toContain('- **Name:** Kai Telegram');
    expect(soul).toContain('## Continuity Boundary');
  });

  it('allows agent add to bind a second agent to the same provider conversation', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.appendFileSync(path.join(runtimeHome, '.env'), 'TELEGRAM_BOT_TOKEN=x\n');
    const seedSettings = createDefaultRuntimeSettings();
    seedSettings.providers.telegram.enabled = true;
    seedSettings.agents.first_agent = {
      name: 'First',
      folder: 'first_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    seedSettings.providerAccounts.telegram_default = {
      agentId: 'first_agent',
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
    };
    saveRuntimeSettings(runtimeHome, seedSettings);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/getChat')) {
          return new Response(
            JSON.stringify({ ok: true, result: { id: 123, title: 'Team' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, result: { status: 'administrator' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const errors: string[] = [];
    vi.doMock('@clack/prompts', () => ({
      log: {
        error: (message: string) => errors.push(message),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
      },
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      note: vi.fn(),
      isCancel: vi.fn(() => false),
    }));
    const { runAgentCommand } = await import('@core/cli/group.js');

    const firstCode = await runAgentCommand(runtimeHome, [
      'add',
      'tg:123',
      '--name',
      'First',
      '--folder',
      'first_agent',
    ]);
    expect({ code: firstCode, errors }).toEqual({ code: 0, errors: [] });
    expect(errors).toEqual([]);
    await expect(
      runAgentCommand(runtimeHome, [
        'add',
        'tg:123',
        '--name',
        'Second',
        '--folder',
        'second_agent',
      ]),
    ).resolves.toBe(0);

    const settings = loadRuntimeSettings(runtimeHome);
    expect(Object.values(settings.bindings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: 'first_agent' }),
        expect.objectContaining({ agent: 'second_agent' }),
      ]),
    );
    expect(Object.values(settings.agents.first_agent.bindings)).toContainEqual(
      expect.objectContaining({ jid: 'tg:123' }),
    );
    expect(Object.values(settings.agents.second_agent.bindings)).toContainEqual(
      expect.objectContaining({ jid: 'tg:123' }),
    );
    expect([...groupsStore.keys()]).toEqual(
      expect.arrayContaining([
        makeAgentThreadQueueKey('tg:123', 'agent:first_agent'),
        makeAgentThreadQueueKey('tg:123', 'agent:second_agent'),
      ]),
    );
    expect(groupsStore.has('tg:123')).toBe(false);
  });

  it('reports ambiguity for a bare Telegram selector with multiple agent routes', () => {
    const firstRouteKey = makeAgentThreadQueueKey(
      'tg:123',
      'agent:first_agent',
    );
    const secondRouteKey = makeAgentThreadQueueKey(
      'tg:123',
      'agent:second_agent',
    );

    const result = resolveGroupSelector(
      {
        [firstRouteKey]: {
          name: 'First',
          folder: 'first_agent',
          trigger: '',
          added_at: '2026-04-24T00:00:00.000Z',
        },
        [secondRouteKey]: {
          name: 'Second',
          folder: 'second_agent',
          trigger: '',
          added_at: '2026-04-24T00:00:00.000Z',
        },
      },
      '123',
    );

    expect(result.found).toBeNull();
    expect(result.error).toContain('ambiguous');
    expect(result.error).toContain('folder/agent selector');
  });

  it('resolves the canonical agent:<folder> id surfaced by status and jobs', () => {
    const firstRouteKey = makeAgentThreadQueueKey(
      'tg:123',
      'agent:first_agent',
    );
    const secondRouteKey = makeAgentThreadQueueKey(
      'tg:456',
      'agent:second_agent',
    );
    const groups = {
      [firstRouteKey]: {
        name: 'First',
        folder: 'first_agent',
        trigger: '',
        added_at: '2026-04-24T00:00:00.000Z',
      },
      [secondRouteKey]: {
        name: 'Second',
        folder: 'second_agent',
        trigger: '',
        added_at: '2026-04-24T00:00:00.000Z',
      },
    };

    const byAgentId = resolveGroupSelector(groups, 'agent:second_agent');
    expect(byAgentId.error).toBeUndefined();
    expect(byAgentId.found?.jid).toBe(secondRouteKey);
    expect(byAgentId.found?.group.folder).toBe('second_agent');

    // Same agent, reachable by folder and by full route JID.
    expect(resolveGroupSelector(groups, 'second_agent').found?.jid).toBe(
      secondRouteKey,
    );
    expect(resolveGroupSelector(groups, secondRouteKey).found?.jid).toBe(
      secondRouteKey,
    );

    // agent:<folder> is agent-only: unknown ids do not fall back to anything.
    const unknown = resolveGroupSelector(groups, 'agent:missing_agent');
    expect(unknown.found).toBeNull();
    expect(unknown.error).toBeUndefined();
  });

  it('refuses a multi-route agent id rather than silently picking one route', () => {
    const routeA = makeAgentThreadQueueKey('tg:123', 'agent:multi_agent');
    const routeB = makeAgentThreadQueueKey('tg:456', 'agent:multi_agent');
    const groups = {
      [routeA]: {
        name: 'Multi',
        folder: 'multi_agent',
        trigger: '',
        added_at: '2026-04-24T00:00:00.000Z',
      },
      [routeB]: {
        name: 'Multi',
        folder: 'multi_agent',
        trigger: '',
        added_at: '2026-04-24T00:00:00.000Z',
      },
    };

    const result = resolveGroupSelector(groups, 'agent:multi_agent');
    expect(result.found).toBeNull();
    expect(result.error).toContain('2 routes');
    // The error must name every route so the user can pick one.
    expect(result.error).toContain(routeA);
    expect(result.error).toContain(routeB);

    // Each route remains individually addressable by its exact JID.
    expect(resolveGroupSelector(groups, routeA).found?.jid).toBe(routeA);
    expect(resolveGroupSelector(groups, routeB).found?.jid).toBe(routeB);
  });

  it('keeps exact route-JID precedence, with agent:<folder> addressing the other agent', () => {
    const collidingJid = 'tg:999';
    const otherRouteKey = makeAgentThreadQueueKey('tg:123', 'agent:tg:999');
    const groups = {
      [collidingJid]: {
        name: 'Direct route',
        folder: 'direct_route',
        trigger: '',
        added_at: '2026-04-24T00:00:00.000Z',
      },
      [otherRouteKey]: {
        name: 'Other',
        folder: collidingJid,
        trigger: '',
        added_at: '2026-04-24T00:00:00.000Z',
      },
    };

    // Exact route key wins -- and stays addressable.
    const byJid = resolveGroupSelector(groups, collidingJid);
    expect(byJid.error).toBeUndefined();
    expect(byJid.found?.jid).toBe(collidingJid);
    expect(byJid.found?.group.folder).toBe('direct_route');

    // The agent whose FOLDER collides is reachable via its canonical id.
    const byAgentId = resolveGroupSelector(groups, `agent:${collidingJid}`);
    expect(byAgentId.error).toBeUndefined();
    expect(byAgentId.found?.jid).toBe(otherRouteKey);
    expect(byAgentId.found?.group.folder).toBe(collidingJid);
  });

  it('does not flag a collision when the colliding folder is the same agent', () => {
    // One agent owning several routes, where its folder equals one route key,
    // is an alias — not a cross-agent collision — and must still resolve.
    const selfJid = 'tg:999';
    const secondRoute = makeAgentThreadQueueKey('tg:123', 'agent:tg:999');
    const result = resolveGroupSelector(
      {
        [selfJid]: {
          name: 'Same agent',
          folder: selfJid,
          trigger: '',
          added_at: '2026-04-24T00:00:00.000Z',
        },
        [secondRoute]: {
          name: 'Same agent',
          folder: selfJid,
          trigger: '',
          added_at: '2026-04-24T00:00:00.000Z',
        },
      },
      selfJid,
    );

    expect(result.error).toBeUndefined();
    expect(result.found?.jid).toBe(selfJid);
    expect(result.found?.group.folder).toBe(selfJid);
  });
});
