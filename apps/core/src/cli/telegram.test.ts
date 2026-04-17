import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';

import {
  normalizeTelegramChatJid,
  registerTelegramMainGroup,
  verifyTelegramChatAccess,
} from './telegram.js';

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
