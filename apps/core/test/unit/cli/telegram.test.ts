import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';

import { readEnvFile } from '@core/cli/env-file.js';
import { envFilePath } from '@core/cli/runtime-home.js';
import { loadRuntimeSettings } from '@core/cli/runtime-settings.js';
import {
  normalizeTelegramChatJid,
  registerTelegramMainGroup,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from '@core/cli/telegram.js';
import { listTelegramRecentChats } from '@core/cli/telegram-chat-discovery.js';

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
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
              },
            },
            {
              update_id: 102,
              message: {
                chat: { id: 99887766, type: 'private', first_name: 'Ravi' },
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
    expect(result.chats[1]?.chatJid).toBe('tg:-100123');
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

    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi.fn(async () => 'telegram-token'),
      text: vi.fn(async () => ''),
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
    expect(loadRuntimeSettings(runtimeHome).channels.telegram.enabled).toBe(
      true,
    );
    expect(outro).toHaveBeenCalledWith(
      'Telegram token saved. Next: run `myclaw agent add <chat-id> --main --requires-trigger false`.',
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
        message: 'Choose the Telegram chat to register as main',
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
    expect(claude).toContain('Static Chat Guidance');
    expect(claude).toContain('memory/continuity brief');
    expect(soul).toContain('# Soul - Who You Are');
    expect(soul).toContain('- **Name:** Kai Telegram');
    expect(soul).toContain('## Continuity Boundary');
  });
});
