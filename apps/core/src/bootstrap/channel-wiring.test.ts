import { describe, expect, it, vi } from 'vitest';

import { RuntimeSettings } from '../cli/runtime-settings.js';
import { Channel } from '../core/types.js';
import { createChannelWiring } from './channel-wiring.js';
import { RuntimeApp } from './runtime-app.js';

function makeRuntimeSettings(enabled: {
  telegram: boolean;
  slack: boolean;
}): RuntimeSettings {
  const allowlist = {
    default: { allow: '*', mode: 'trigger' as const },
    agents: {},
    logDenied: true,
  };
  return {
    channels: {
      telegram: { enabled: enabled.telegram, senderAllowlist: allowlist },
      slack: { enabled: enabled.slack, senderAllowlist: allowlist },
    },
    features: {
      memory: true,
      embeddings: false,
      dreaming: false,
    },
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'telegram',
    connect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeApp(registeredGroups: Record<string, any> = {}): RuntimeApp {
  return {
    channels: [],
    queue: {} as RuntimeApp['queue'],
    loadState: vi.fn(),
    saveState: vi.fn(),
    getOrRecoverCursor: vi.fn(),
    registerGroup: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    setRegisteredGroupsForTest: vi.fn(),
    ensureOneCLIAgentsForRegisteredGroups: vi.fn(),
    processGroupMessages: vi.fn(),
    getRegisteredGroups: vi.fn(() => registeredGroups),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
  };
}

describe('createChannelWiring', () => {
  it('skips disabled channels in runtime settings', async () => {
    const app = makeApp();
    const info = vi.fn();

    const wiring = createChannelWiring(app, {
      getRegisteredChannelNames: () => ['telegram', 'slack'],
      getChannelFactory: vi.fn(() => vi.fn(() => makeChannel())) as any,
      logger: {
        info,
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: false }),
    );

    expect(app.channels).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('warns and skips when credentials are missing', async () => {
    const app = makeApp();
    const warn = vi.fn();

    const wiring = createChannelWiring(app, {
      getRegisteredChannelNames: () => ['telegram'],
      getChannelFactory: vi.fn(() => vi.fn(() => null)) as any,
      logger: {
        info: vi.fn(),
        warn,
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    expect(app.channels).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('drops disallowed inbound sender before persistence', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main', isMain: true },
    });
    const storeMessage = vi.fn();
    let onMessage: ((chatJid: string, msg: any) => void) | undefined;

    const wiring = createChannelWiring(app, {
      getRegisteredChannelNames: () => ['telegram'],
      getChannelFactory: vi.fn(() => (opts: any) => {
        onMessage = opts.onMessage;
        return makeChannel();
      }) as any,
      storeMessage,
      loadSenderAllowlist: vi.fn(() => ({}) as any),
      shouldDropMessage: vi.fn(() => true),
      isSenderAllowed: vi.fn(() => false),
      shouldLogDenied: vi.fn(() => true),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    onMessage?.('tg:123', {
      id: 'm1',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('routes remote-control commands and does not store as normal messages', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main', isMain: true },
    });
    const storeMessage = vi.fn();
    const handleRemoteControl = vi.fn(async () => {});
    let onMessage: ((chatJid: string, msg: any) => void) | undefined;

    const wiring = createChannelWiring(app, {
      getRegisteredChannelNames: () => ['telegram'],
      getChannelFactory: vi.fn(() => (opts: any) => {
        onMessage = opts.onMessage;
        return makeChannel();
      }) as any,
      storeMessage,
      asRemoteControlCommand: vi.fn(() => ({ command: 'start' }) as any),
      handleRemoteControlCommand: handleRemoteControl as any,
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    onMessage?.('tg:123', {
      id: 'm2',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: '/remote start',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(handleRemoteControl).toHaveBeenCalledOnce();
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('stores normal inbound messages', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main', isMain: true },
    });
    const storeMessage = vi.fn();
    let onMessage: ((chatJid: string, msg: any) => void) | undefined;

    const wiring = createChannelWiring(app, {
      getRegisteredChannelNames: () => ['telegram'],
      getChannelFactory: vi.fn(() => (opts: any) => {
        onMessage = opts.onMessage;
        return makeChannel();
      }) as any,
      storeMessage,
      asRemoteControlCommand: vi.fn(() => null),
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const msg = {
      id: 'm3',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    onMessage?.('tg:123', msg);

    expect(storeMessage).toHaveBeenCalledWith(msg);
  });

  it('routes permission approvals through main groups and falls back safely', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main', isMain: true },
      'tg:other': { name: 'Other', folder: 'other' },
    });

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:main'),
      requestPermissionApproval: vi.fn(async () => ({ approved: true })),
    });

    app.channels.push(approvalChannel);

    const wiring = createChannelWiring(app);
    const result = await wiring.requestPermissionApproval({
      requestId: 'req-1',
      sourceGroup: 'tg:other',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);

    const fallbackWiring = createChannelWiring(makeApp({}));
    const fallback = await fallbackWiring.requestPermissionApproval({
      requestId: 'req-2',
      sourceGroup: 'tg:none',
      toolName: 'danger-tool',
    });

    expect(fallback).toEqual({
      approved: false,
      reason: 'No main channel supports interactive permission approvals',
    });
  });

  it('returns empty answers when user-question flow fails', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main', isMain: true },
    });

    const questionChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:main'),
      requestUserAnswer: vi.fn(async () => {
        throw new Error('request failed');
      }),
    });
    app.channels.push(questionChannel);

    const wiring = createChannelWiring(app, {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    const response = await wiring.requestUserAnswer({
      requestId: 'q-1',
      sourceGroup: 'tg:main',
      questions: [],
    });

    expect(response).toEqual({ requestId: 'q-1', answers: {} });
  });
});
