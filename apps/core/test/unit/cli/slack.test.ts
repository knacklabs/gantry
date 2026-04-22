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
import { readEnvFile } from '@core/cli/env-file.js';
import { envFilePath } from '@core/cli/runtime-home.js';
import { loadRuntimeSettings } from '@core/cli/runtime-settings.js';
import { listSlackRecentChats } from '@core/cli/slack-chat-discovery.js';

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

describe('cli slack helpers', () => {
  function makeRuntimeHome(): string {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-slack-test-'),
    );
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

  it('rejects non-xapp app token prefix immediately', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await validateSlackAppToken('xoxb-not-app-token');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('must start with xapp-');
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(loadRuntimeSettings(runtimeHome).channels.slack.enabled).toBe(false);
    expect(outro).toHaveBeenCalledWith('Slack connect cancelled.');
  });

  it('seeds CLAUDE.md and SOUL.md when registering the main group', async () => {
    const runtimeHome = makeRuntimeHome();

    const result = await registerSlackMainGroup({
      runtimeHome,
      chatJid: 'sl:C0123456789',
      displayName: 'Kai Slack',
    });

    const groupDir = path.join(runtimeHome, 'agents', result.folder);
    const claude = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    const soul = fs.readFileSync(path.join(groupDir, 'SOUL.md'), 'utf-8');

    expect(result.groupName).toBe('Kai Slack');
    expect(claude).toContain('Static Chat Guidance');
    expect(claude).toContain('memory/continuity brief');
    expect(soul).toContain('# Soul - Who You Are');
    expect(soul).toContain('- **Name:** Kai Slack');
    expect(soul).toContain('## Continuity Boundary');
  });
});
