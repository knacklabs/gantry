import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';

import { readEnvFile } from '@core/config/env/file.js';
import { envFilePath } from '@core/config/settings/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import {
  normalizeTelegramChatJid,
  registerTelegramMainGroup,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from '@core/cli/telegram.js';
import { listTelegramRecentChats } from '@core/cli/telegram-chat-discovery.js';

const groupsStore = vi.hoisted(() => new Map<string, any>());

vi.mock('@core/cli/runtime-group-db.js', () => ({
  openRuntimeGroupDb: async () => ({
    countRegisteredGroupsByJidPrefix: async (jidPrefix: string) => {
      const normalized = jidPrefix.endsWith('%')
        ? jidPrefix.slice(0, -1)
        : jidPrefix;
      return Array.from(groupsStore.keys()).filter((jid) =>
        jid.startsWith(normalized),
      ).length;
    },
    getAllRegisteredGroups: async () =>
      Object.fromEntries(groupsStore.entries()),
    setRegisteredGroup: async (jid: string, group: any) => {
      groupsStore.set(jid, group);
    },
    deleteRegisteredGroup: async (jid: string) => {
      groupsStore.delete(jid);
    },
    deleteSession: async () => {},
    close: async () => {},
  }),
}));

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  groupsStore.clear();
  while (runtimeHomes.length > 0) {
    const runtimeHome = runtimeHomes.pop();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('cli telegram helpers', () => {
  function makeRuntimeHome(): string {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-telegram-test-'),
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

    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi.fn(async () => 'telegram-token'),
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
    expect(readEnvFile(envFilePath(runtimeHome)).TELEGRAM_BOT_TOKEN).toBe(
      'telegram-token',
    );
    expect(loadRuntimeSettings(runtimeHome).providers.telegram.enabled).toBe(
      true,
    );
    expect(outro).toHaveBeenCalledWith(
      'Telegram token saved. Next: run `myclaw provider connect telegram` to register a conversation.',
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
        message: 'Choose the Telegram chat for the Main Agent',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'tg:-100123' }),
          expect.objectContaining({ value: 'manual' }),
          expect.objectContaining({ value: 'skip' }),
        ]),
      }),
    );
    expect(readEnvFile(envFilePath(runtimeHome)).TELEGRAM_BOT_TOKEN).toBe(
      'telegram-token',
    );
  });

  it('telegram connect enables session admin commands for an explicitly entered sender', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const select = vi.fn(async () => 'tg:-100123');
    const text = vi.fn(async () => '5759865942');

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
        groupName: 'Main Agent',
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
          'Telegram admin/approver user IDs for permissions; seeds main_agent DM admin and conversation approvers (required)',
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
        groupName: 'Main Agent',
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
          'Telegram admin/approver user IDs for permissions; seeds main_agent DM admin and conversation approvers (required)',
        defaultValue: '',
      }),
    );
  });

  it('seeds CLAUDE.md and SOUL.md when registering the main group', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerTelegramMainGroup({
      runtimeHome,
      chatJid: 'tg:-100123',
      displayName: 'Kai Telegram',
    });

    const groupDir = path.join(runtimeHome, 'agents', result.folder);
    const claude = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    const soul = fs.readFileSync(path.join(groupDir, 'SOUL.md'), 'utf-8');

    expect(result.groupName).toBe('Kai Telegram');
    expect(result.folder).toBe('main_agent');
    expect(claude).toContain('Static Chat Guidance');
    expect(claude).toContain('query-retrieved memory context');
    expect(claude).toContain(
      'When the user says "continue", call memory_search before guessing.',
    );
    expect(claude).toContain(
      'Use request_skill_install, request_skill_proposal, request_skill_dependency_install, request_mcp_server, or request_permission for capability changes.',
    );
    expect(claude).toContain(
      'Agents with selected admin capabilities may use service_restart after approved changes and register_agent for conversation binding.',
    );
    expect(soul).toContain('# Soul - Who You Are');
    expect(soul).toContain('- **Name:** Kai Telegram');
    expect(soul).toContain('## Continuity Boundary');
  });
});
