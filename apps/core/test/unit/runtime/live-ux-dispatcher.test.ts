import { describe, expect, it, vi } from 'vitest';

import { createChannelWiringLiveUx } from '@core/app/bootstrap/channel-wiring-live-ux.js';
import { createAppChannel } from '@core/channels/app.js';
import type { ChannelAdapter } from '@core/channels/channel-provider.js';
import { DiscordChannel } from '@core/channels/discord/index.js';
import { SlackChannel } from '@core/channels/slack/channel-adapter.js';
import { TeamsChannel } from '@core/channels/teams/index.js';
import { TelegramChannel } from '@core/channels/telegram/channel-adapter.js';
import {
  LiveUxRateLimitError,
  type ChannelLiveUxCapability,
} from '@core/domain/channel-live-ux.js';
import { createLiveUxDispatcher } from '@core/runtime/live-ux-dispatcher.js';
import { StatefulLivenessProvider } from '../../harness/stateful-liveness-provider.js';

type TestChannelOverrides = Omit<Partial<ChannelAdapter>, 'liveUx'> & {
  liveUx?: Omit<ChannelLiveUxCapability, 'canonicalTarget'> &
    Partial<Pick<ChannelLiveUxCapability, 'canonicalTarget'>>;
};

function channel(
  name: string,
  overrides: TestChannelOverrides,
): ChannelAdapter {
  const adapter = {
    name,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    sendMessage: vi.fn(async () => undefined),
    ...overrides,
  } as ChannelAdapter;
  if (adapter.liveUx && !adapter.liveUx.canonicalTarget) {
    adapter.liveUx = {
      ...adapter.liveUx,
      canonicalTarget: (target) => {
        if (target.operation === 'typing') {
          return { key: `typing\n${target.jid}\n${target.threadId ?? ''}` };
        }
        const emoji =
          adapter.liveUx?.reactions !== 'none' &&
          adapter.liveUx?.reactions.removal === 'exact'
            ? target.emoji
            : '';
        return {
          key: `reaction\n${target.jid}\n${target.threadId ?? ''}\n${target.messageRef}\n${emoji}`,
        };
      },
    };
  }
  return adapter;
}

function binding(channel: ChannelAdapter, identity: object = channel) {
  return { channel, identity };
}

function rememberDiscordReactionTarget(
  channel: DiscordChannel,
  jid = 'dc:42',
  messageRef = 'message-1',
  channelId = '42',
): void {
  const messageChannelIds = Reflect.get(channel, 'messageChannelIds') as {
    remember(jid: string, messageRef: string, channelId: string): void;
  };
  messageChannelIds.remember(jid, messageRef, channelId);
}

describe('live UX dispatcher', () => {
  it('declares truthful built-in adapter capabilities without inferred operations', async () => {
    const app = await createAppChannel({
      liveUxBindingGeneration: () => 1,
    } as never);
    const slack = new SlackChannel('bot', 'app', {} as never);
    const telegram = new TelegramChannel('bot', {} as never);
    const discord = new DiscordChannel('bot', 'app', {} as never);
    const teams = new TeamsChannel({} as never, {} as never, {} as never);

    expect(app.liveUx).toMatchObject({
      typing: 'explicit',
      reactions: 'none',
      canonicalTarget: expect.any(Function),
    });
    expect(slack.liveUx).toMatchObject({
      typing: 'none',
      reactions: { removal: 'exact' },
      canonicalTarget: expect.any(Function),
    });
    expect(telegram.liveUx).toMatchObject({
      typing: 'expiring',
      reactions: { removal: 'all' },
      canonicalTarget: expect.any(Function),
    });
    expect(discord.liveUx).toMatchObject({
      typing: 'expiring',
      reactions: { removal: 'exact' },
      canonicalTarget: expect.any(Function),
    });
    expect(teams.liveUx).toMatchObject({
      typing: 'none',
      reactions: 'none',
      canonicalTarget: expect.any(Function),
    });
    expect('addReaction' in teams).toBe(false);
  });

  it('routes reactions and typing to the account that owns the route', async () => {
    const accountOne = new StatefulLivenessProvider({
      name: 'telegram-one',
      reactionRemoval: 'all',
    });
    const accountTwo = new StatefulLivenessProvider({
      name: 'telegram-two',
      reactionRemoval: 'all',
    });
    const channels = new Map([
      ['account-one', accountOne.adapter],
      ['account-two', accountTwo.adapter],
    ]);
    const liveUx = createChannelWiringLiveUx({
      findBinding: (_jid, providerAccountId) => {
        const resolved = providerAccountId
          ? channels.get(providerAccountId)
          : undefined;
        return resolved ? binding(resolved) : undefined;
      },
      logger: { warn: vi.fn() },
    });

    expect(
      liveUx.reactionRemovalMode('tg:42', {
        providerAccountId: 'account-two',
      }),
    ).toBe('all');

    await liveUx.setTyping('tg:42', true, {
      providerAccountId: 'account-two',
      threadId: '7',
    });
    await liveUx.addReaction('tg:42', '10', 'seen', {
      providerAccountId: 'account-two',
      threadId: '7',
    });

    expect(accountOne.typing.size).toBe(0);
    expect(accountOne.reactions.size).toBe(0);
    expect(accountTwo.typing.get('tg:42\n7')).toBe(true);
    expect(accountTwo.reactionSet('tg:42', '10', '7')).toEqual(
      new Set(['seen']),
    );
  });

  it('keeps concurrent Telegram topic typing in separate lanes', async () => {
    let releaseTopicA: (() => void) | undefined;
    const delivered: string[] = [];
    const setTyping = vi.fn(
      async (_jid: string, _isTyping: boolean, options) => {
        if (options?.threadId === 'topic-a') {
          await new Promise<void>((resolve) => {
            releaseTopicA = resolve;
          });
        }
        delivered.push(options?.threadId ?? '');
      },
    );
    const telegram = new TelegramChannel('bot', {} as never);
    const adapter = channel('telegram', {
      liveUx: telegram.liveUx,
      setTyping,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(adapter),
      logger: { warn: vi.fn() },
    });

    const topicA = liveUx.setTyping('tg:42', true, {
      threadId: 'topic-a',
    });
    await vi.waitFor(() => expect(setTyping).toHaveBeenCalledOnce());
    const topicB = liveUx.setTyping('tg:42', true, {
      threadId: 'topic-b',
    });
    await vi.waitFor(() => expect(setTyping).toHaveBeenCalledTimes(2));

    releaseTopicA?.();
    await Promise.all([topicA, topicB]);
    expect(delivered.sort()).toEqual(['topic-a', 'topic-b']);
  });

  it('keeps two-account liveness isolated when both accounts own the same route', async () => {
    const accountOne = new StatefulLivenessProvider();
    const accountTwo = new StatefulLivenessProvider();
    const channels = new Map([
      ['account-one', accountOne.adapter],
      ['account-two', accountTwo.adapter],
    ]);
    const warn = vi.fn();
    const liveUx = createChannelWiringLiveUx({
      findBinding: (_jid, providerAccountId) => {
        const resolved = providerAccountId
          ? channels.get(providerAccountId)
          : undefined;
        return resolved ? binding(resolved) : undefined;
      },
      logger: { warn },
    });

    await Promise.all([
      liveUx.addReaction('sl:C1', 'message-1', 'seen', {
        providerAccountId: 'account-one',
      }),
      liveUx.addReaction('sl:C1', 'message-2', 'running', {
        providerAccountId: 'account-two',
      }),
    ]);
    await liveUx.addReaction('sl:C1', 'missing', 'seen');

    expect(accountOne.reactionSet('sl:C1', 'message-1')).toEqual(
      new Set(['seen']),
    );
    expect(accountOne.reactionSet('sl:C1', 'message-2')).toEqual(new Set());
    expect(accountTwo.reactionSet('sl:C1', 'message-2')).toEqual(
      new Set(['running']),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'reaction.add', jid: 'sl:C1' }),
      'Live UX delivery sink could not be resolved',
    );
  });

  it('warns loudly when route resolution finds no sink', async () => {
    const warn = vi.fn();
    const liveUx = createLiveUxDispatcher({
      findBinding: () => undefined,
      logger: { warn },
    });

    await expect(
      liveUx.setTyping('dc:42', true, { providerAccountId: 'missing' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'typing',
        jid: 'dc:42',
        providerAccountId: 'missing',
      }),
      'Live UX delivery sink could not be resolved',
    );
  });

  it('contains a throwing typing adapter so liveness cannot reject the turn', async () => {
    const warn = vi.fn();
    const throwing = channel('discord', {
      liveUx: {
        typing: 'expiring',
        reactions: { removal: 'exact' },
      },
      setTyping: vi.fn(async () => {
        throw new Error('Discord setTyping failed');
      }),
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(throwing),
      logger: { warn },
    });

    await expect(liveUx.setTyping('dc:42', true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'typing', jid: 'dc:42' }),
      'Live UX delivery failed',
    );
  });

  it('republishes explicit typing refreshes and always delivers terminal off', async () => {
    const provider = new StatefulLivenessProvider({
      name: 'app',
      typing: 'explicit',
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(provider.adapter),
      logger: { warn: vi.fn() },
    });

    await liveUx.setTyping('app:conversation', true);
    await liveUx.setTyping('app:conversation', true);
    await liveUx.setTyping('app:conversation', false);
    await liveUx.setTyping('app:conversation', false);

    expect(provider.typing.get('app:conversation\n')).toBe(false);
    expect(provider.typingHistory).toEqual([
      expect.objectContaining({ isTyping: true }),
      expect.objectContaining({ isTyping: true }),
      expect.objectContaining({ isTyping: false }),
      expect.objectContaining({ isTyping: false }),
    ]);
  });

  it('does not suppress explicit typing after the resolved binding changes', async () => {
    const firstTyping = vi.fn(async () => undefined);
    const secondTyping = vi.fn(async () => undefined);
    const first = channel('app', {
      liveUx: { typing: 'explicit', reactions: 'none' },
      setTyping: firstTyping,
    });
    const second = channel('app', {
      liveUx: { typing: 'explicit', reactions: 'none' },
      setTyping: secondTyping,
    });
    let resolved = binding(first);
    const liveUx = createLiveUxDispatcher({
      findBinding: () => resolved,
      logger: { warn: vi.fn() },
    });

    await liveUx.setTyping('app:conversation', true);
    await liveUx.setTyping('app:conversation', true);
    resolved = binding(second);
    await liveUx.setTyping('app:conversation', true);

    expect(firstTyping).toHaveBeenCalledTimes(2);
    expect(secondTyping).toHaveBeenCalledOnce();
  });

  it('invalidates explicit typing state when terminal off is not confirmed', async () => {
    const setTyping = vi
      .fn<ChannelAdapter['setTyping']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('off failed'))
      .mockResolvedValueOnce(undefined);
    const appChannel = channel('app', {
      liveUx: { typing: 'explicit', reactions: 'none' },
      setTyping,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(appChannel),
      logger: { warn: vi.fn() },
    });

    await liveUx.setTyping('app:conversation', true);
    await liveUx.setTyping('app:conversation', false);
    await liveUx.setTyping('app:conversation', true);

    expect(setTyping).toHaveBeenCalledTimes(3);
  });

  it('serializes explicit typing so stale start completion cannot override terminal off', async () => {
    let settleStart: (() => void) | undefined;
    const setTyping = vi.fn(
      async (_jid: string, isTyping: boolean): Promise<void> => {
        if (isTyping && setTyping.mock.calls.length === 1) {
          await new Promise<void>((resolve) => {
            settleStart = resolve;
          });
        }
      },
    );
    const appChannel = channel('app', {
      liveUx: { typing: 'explicit', reactions: 'none' },
      setTyping,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(appChannel),
      logger: { warn: vi.fn() },
    });

    const start = liveUx.setTyping('app:conversation', true);
    const stop = liveUx.setTyping('app:conversation', false);
    await vi.waitFor(() => expect(setTyping).toHaveBeenCalledTimes(1));
    settleStart?.();
    await Promise.all([start, stop]);
    await liveUx.setTyping('app:conversation', true);

    expect(setTyping.mock.calls.map((call) => call[1])).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('serializes concurrent explicit typing refreshes', async () => {
    let settleStart: (() => void) | undefined;
    const setTyping = vi.fn(async (): Promise<void> => {
      if (setTyping.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          settleStart = resolve;
        });
      }
    });
    const appChannel = channel('app', {
      liveUx: { typing: 'explicit', reactions: 'none' },
      setTyping,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(appChannel),
      logger: { warn: vi.fn() },
    });

    const first = liveUx.setTyping('app:conversation', true);
    const duplicate = liveUx.setTyping('app:conversation', true);
    await vi.waitFor(() => expect(setTyping).toHaveBeenCalledTimes(1));
    settleStart?.();
    await Promise.all([first, duplicate]);

    expect(setTyping).toHaveBeenCalledTimes(2);
  });

  it('retries a rate-limited operation exactly once', async () => {
    const transport = vi.fn(async () => {
      throw new LiveUxRateLimitError(25, new Error('429'));
    });
    const wait = vi.fn(async () => undefined);
    const liveUx = createLiveUxDispatcher({
      findBinding: () =>
        binding(
          channel('slack', {
            liveUx: {
              typing: 'none',
              reactions: { removal: 'exact' },
            },
            addReaction: transport,
          }),
        ),
      logger: { warn: vi.fn() },
      wait,
    });

    await expect(
      liveUx.addReaction('sl:C1', '100.1', 'seen'),
    ).resolves.toBeUndefined();

    expect(transport).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(25);
  });

  it('skips a rate-limit reaction retry superseded by removal', async () => {
    let releaseRetry: (() => void) | undefined;
    const addReaction = vi.fn(async () => {
      throw new LiveUxRateLimitError(25, new Error('429'));
    });
    const removeReaction = vi.fn(async () => undefined);
    const wait = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          releaseRetry = resolve;
        }),
    );
    const adapter = channel('slack', {
      liveUx: { typing: 'none', reactions: { removal: 'exact' } },
      addReaction,
      removeReaction,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(adapter),
      logger: { warn: vi.fn() },
      wait,
    });

    const add = liveUx.addReaction('sl:C1', '100.1', 'seen');
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    const removal = liveUx.removeReaction('sl:C1', '100.1', 'seen');
    expect(removeReaction).not.toHaveBeenCalled();
    releaseRetry?.();
    await Promise.all([add, removal]);

    expect(addReaction).toHaveBeenCalledOnce();
    expect(removeReaction).toHaveBeenCalledOnce();
  });

  it('uses the adapter canonical target and retains cooldown across alias supersession', async () => {
    let releaseRetry: (() => void) | undefined;
    const addReaction = vi.fn(async () => {
      throw new LiveUxRateLimitError(25, new Error('429'));
    });
    const removeReaction = vi.fn(async () => undefined);
    const wait = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          releaseRetry = resolve;
        }),
    );
    const adapter = channel('slack', {
      liveUx: {
        typing: 'none',
        reactions: { removal: 'exact' },
        canonicalTarget: (target) => ({
          key:
            target.operation === 'typing'
              ? `typing:${target.jid}`
              : `reaction:${target.jid}:${target.messageRef}:${['seen', 'eyes'].includes(target.emoji) ? 'eyes' : target.emoji}`,
        }),
      },
      addReaction,
      removeReaction,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(adapter),
      logger: { warn: vi.fn() },
      wait,
    });

    const add = liveUx.addReaction('sl:C1', '100.1', 'seen');
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    const supersededRemoval = liveUx.removeReaction('sl:C1', '100.1', 'eyes');
    const newestRemoval = liveUx.removeReaction('sl:C1', '100.1', 'eyes');

    expect(removeReaction).not.toHaveBeenCalled();
    releaseRetry?.();
    await Promise.all([add, supersededRemoval, newestRemoval]);

    expect(addReaction).toHaveBeenCalledOnce();
    expect(removeReaction).toHaveBeenCalledOnce();
  });

  it.each([
    ['add then remove', 'add' as const],
    ['remove then add', 'remove' as const],
  ])(
    'supersedes a different-emoji retry message-wide for removal-all: %s',
    async (_case, rateLimitedOperation) => {
      let releaseRetry: (() => void) | undefined;
      const addReaction = vi.fn(async () => {
        if (rateLimitedOperation === 'add') {
          throw new LiveUxRateLimitError(25, new Error('429'));
        }
      });
      const removeReaction = vi.fn(async () => {
        if (rateLimitedOperation === 'remove') {
          throw new LiveUxRateLimitError(25, new Error('429'));
        }
      });
      const wait = vi.fn(
        async () =>
          new Promise<void>((resolve) => {
            releaseRetry = resolve;
          }),
      );
      const adapter = channel('telegram', {
        liveUx: { typing: 'expiring', reactions: { removal: 'all' } },
        addReaction,
        removeReaction,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        wait,
      });

      const first =
        rateLimitedOperation === 'add'
          ? liveUx.addReaction('tg:42', '10', 'seen')
          : liveUx.removeReaction('tg:42', '10', 'seen');
      await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
      const superseding =
        rateLimitedOperation === 'add'
          ? liveUx.removeReaction('tg:42', '10', 'running')
          : liveUx.addReaction('tg:42', '10', 'running');
      expect(addReaction).toHaveBeenCalledTimes(
        rateLimitedOperation === 'add' ? 1 : 0,
      );
      expect(removeReaction).toHaveBeenCalledTimes(
        rateLimitedOperation === 'remove' ? 1 : 0,
      );
      releaseRetry?.();
      await Promise.all([first, superseding]);

      expect(addReaction).toHaveBeenCalledOnce();
      expect(removeReaction).toHaveBeenCalledOnce();
    },
  );

  it('skips a rate-limit typing retry superseded by terminal off', async () => {
    let releaseRetry: (() => void) | undefined;
    const setTyping = vi.fn(async (_jid: string, isTyping: boolean) => {
      if (isTyping) {
        throw new LiveUxRateLimitError(25, new Error('429'));
      }
    });
    const wait = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          releaseRetry = resolve;
        }),
    );
    const adapter = channel('app', {
      liveUx: { typing: 'explicit', reactions: 'none' },
      setTyping,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(adapter),
      logger: { warn: vi.fn() },
      wait,
    });

    const start = liveUx.setTyping('app:conversation', true);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    const stop = liveUx.setTyping('app:conversation', false);
    expect(setTyping).toHaveBeenCalledTimes(1);
    releaseRetry?.();
    await Promise.all([start, stop]);

    expect(setTyping.mock.calls.map((call) => call[1])).toEqual([true, false]);
  });

  it('contains retry-delay failures so liveness cannot reject the turn', async () => {
    const transport = vi.fn(async () => {
      throw new LiveUxRateLimitError(25, new Error('429'));
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () =>
        binding(
          channel('slack', {
            liveUx: {
              typing: 'none',
              reactions: { removal: 'exact' },
            },
            addReaction: transport,
          }),
        ),
      logger: { warn: vi.fn() },
      wait: vi.fn(async () => {
        throw new Error('retry scheduler unavailable');
      }),
    });

    await expect(
      liveUx.addReaction('sl:C1', '100.1', 'seen'),
    ).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'typing',
      (liveUx: ReturnType<typeof createLiveUxDispatcher>) =>
        liveUx.setTyping('dc:42', true),
    ],
    [
      'reaction add',
      (liveUx: ReturnType<typeof createLiveUxDispatcher>) =>
        liveUx.addReaction('dc:42', 'message-1', 'seen'),
    ],
    [
      'reaction removal',
      (liveUx: ReturnType<typeof createLiveUxDispatcher>) =>
        liveUx.removeReaction('dc:42', 'message-1', 'seen'),
    ],
  ])(
    'keeps Discord %s transport attempts at two under rate limiting',
    async (_operation, deliver) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response('{}', {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '1' },
          }),
      );
      try {
        const discord = new DiscordChannel('bot', 'app', {} as never);
        rememberDiscordReactionTarget(discord);
        const liveUx = createLiveUxDispatcher({
          findBinding: () => binding(discord),
          logger: { warn: vi.fn() },
          wait: vi.fn(async () => undefined),
        });

        await expect(deliver(liveUx)).resolves.toBeUndefined();

        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it('retries Discord removal once on a fresh channel without cached reaction state', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    try {
      const discord = new DiscordChannel('bot', 'app', {} as never);
      rememberDiscordReactionTarget(discord);
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(discord),
        logger: { warn: vi.fn() },
        wait: vi.fn(async () => undefined),
      });

      await liveUx.removeReaction('dc:42', 'message-1', 'seen');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.every(([, init]) => init?.method === 'DELETE'),
      ).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('bounds each attempt and catches a transport that never settles', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const liveUx = createLiveUxDispatcher({
        findBinding: () =>
          binding(
            channel('discord', {
              liveUx: {
                typing: 'expiring',
                reactions: { removal: 'exact' },
              },
              setTyping: vi.fn(
                (_jid, _isTyping, options) =>
                  new Promise<void>((_resolve, reject) => {
                    options?.signal?.addEventListener(
                      'abort',
                      () => reject(options.signal?.reason),
                      { once: true },
                    );
                  }),
              ),
            }),
          ),
        logger: { warn },
        attemptDeadlineMs: 20,
      });

      const delivery = liveUx.setTyping('dc:42', true);
      await vi.advanceTimersByTimeAsync(20);

      await expect(delivery).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'typing', jid: 'dc:42' }),
        'Live UX delivery failed',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['typing', 'reaction add'] as const)(
    'aborts timed-out %s before a late visible side effect can land',
    async (operation) => {
      vi.useFakeTimers();
      try {
        const visibleEffects: string[] = [];
        const transport = vi.fn(
          async (
            _jid: string,
            _value: boolean | string,
            _emojiOrOptions?: string | { signal?: AbortSignal },
            reactionOptions?: { signal?: AbortSignal },
          ) => {
            const options =
              operation === 'typing'
                ? (_emojiOrOptions as { signal?: AbortSignal })
                : reactionOptions;
            await new Promise((resolve) => setTimeout(resolve, 40));
            if (!options?.signal?.aborted) visibleEffects.push(operation);
          },
        );
        const adapter = channel('test', {
          liveUx: {
            typing: 'expiring',
            reactions: { removal: 'exact' },
          },
          setTyping: transport as ChannelAdapter['setTyping'],
          addReaction: transport as ChannelAdapter['addReaction'],
        });
        const liveUx = createLiveUxDispatcher({
          findBinding: () => binding(adapter),
          logger: { warn: vi.fn() },
          attemptDeadlineMs: 20,
        });

        const delivery =
          operation === 'typing'
            ? liveUx.setTyping('test:42', true)
            : liveUx.addReaction('test:42', 'message-1', 'seen');
        await vi.advanceTimersByTimeAsync(20);
        await delivery;
        await vi.advanceTimersByTimeAsync(20);

        expect(visibleEffects).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('reasserts a reaction after an ambiguous timeout lands late', async () => {
    vi.useFakeTimers();
    try {
      const visibleEffects: string[] = [];
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          visibleEffects.push('seen');
          return new Response(null, { status: 204 });
        });
      const discord = new DiscordChannel('bot', 'app', {} as never);
      rememberDiscordReactionTarget(discord);
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(discord),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
      });

      const first = liveUx.addReaction('dc:42', 'message-1', 'seen');
      await vi.advanceTimersByTimeAsync(20);
      await first;
      await vi.advanceTimersByTimeAsync(20);

      const reconciliation = liveUx.addReaction('dc:42', 'message-1', 'seen');
      await vi.advanceTimersByTimeAsync(20);
      await reconciliation;
      await vi.advanceTimersByTimeAsync(20);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(visibleEffects).toEqual(['seen', 'seen']);
      fetchMock.mockRestore();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('invalidates a confirmed reaction cache when removal is ambiguous', async () => {
    vi.useFakeTimers();
    try {
      const visibleEffects: boolean[] = [];
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) => {
          if (init?.method === 'DELETE') {
            await new Promise((resolve) => setTimeout(resolve, 40));
            visibleEffects.push(false);
          } else {
            visibleEffects.push(true);
          }
          return new Response(null, { status: 204 });
        });
      const discord = new DiscordChannel('bot', 'app', {} as never);
      rememberDiscordReactionTarget(discord);
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(discord),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
      });

      await liveUx.addReaction('dc:42', 'message-1', 'seen');
      const removal = liveUx.removeReaction('dc:42', 'message-1', 'seen');
      await vi.advanceTimersByTimeAsync(20);
      await removal;
      await vi.advanceTimersByTimeAsync(20);
      await liveUx.addReaction('dc:42', 'message-1', 'seen');

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(visibleEffects).toEqual([true, false, true]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('reconciles a late ambiguous typing start with terminal off', async () => {
    vi.useFakeTimers();
    try {
      const visibleEffects: boolean[] = [];
      const setTyping = vi.fn(async (_jid: string, isTyping: boolean) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        visibleEffects.push(isTyping);
      });
      const adapter = channel('app', {
        liveUx: { typing: 'explicit', reactions: 'none' },
        setTyping,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
      });

      const start = liveUx.setTyping('app:conversation', true);
      await vi.advanceTimersByTimeAsync(20);
      await start;
      const stop = liveUx.setTyping('app:conversation', false);
      await vi.advanceTimersByTimeAsync(40);
      await stop;
      await vi.advanceTimersByTimeAsync(20);

      expect(setTyping.mock.calls.map((call) => call[1])).toEqual([
        true,
        false,
      ]);
      expect(visibleEffects).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes an in-flight reaction add before the superseding removal', async () => {
    vi.useFakeTimers();
    try {
      let reactionVisible = false;
      const addReaction = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        reactionVisible = true;
      });
      const removeReaction = vi.fn(async () => {
        reactionVisible = false;
      });
      const adapter = channel('telegram', {
        liveUx: { typing: 'expiring', reactions: { removal: 'all' } },
        addReaction,
        removeReaction,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 100,
      });

      const add = liveUx.addReaction('tg:42', '10', 'seen');
      await vi.advanceTimersByTimeAsync(0);
      const removal = liveUx.removeReaction('tg:42', '10', 'seen');
      expect(removeReaction).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(40);
      await Promise.all([add, removal]);

      expect(addReaction).toHaveBeenCalledOnce();
      expect(removeReaction).toHaveBeenCalledOnce();
      expect(reactionVisible).toBe(false);
      expect(liveUx.pendingTargetCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops superseded queued work and releases all settled target state', async () => {
    let settleAdd: (() => void) | undefined;
    const addReaction = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          settleAdd = resolve;
        }),
    );
    const removeReaction = vi.fn(async () => undefined);
    const adapter = channel('slack', {
      liveUx: { typing: 'none', reactions: { removal: 'exact' } },
      addReaction,
      removeReaction,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(adapter),
      logger: { warn: vi.fn() },
    });

    const inFlight = liveUx.addReaction('sl:C1', '100.1', 'seen');
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledOnce());
    const superseded = liveUx.addReaction('sl:C1', '100.1', 'seen');
    const newest = liveUx.removeReaction('sl:C1', '100.1', 'seen');
    settleAdd?.();
    await Promise.all([inFlight, superseded, newest]);

    expect(addReaction).toHaveBeenCalledOnce();
    expect(removeReaction).toHaveBeenCalledOnce();
    expect(liveUx.pendingTargetCount()).toBe(0);
  });

  it('releases a timed-out lane after grace when the adapter ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const visibleEffects: boolean[] = [];
      const setTyping = vi.fn(
        async (_jid: string, isTyping: boolean) =>
          new Promise<void>((resolve) => {
            if (!isTyping) {
              visibleEffects.push(false);
              resolve();
            }
          }),
      );
      const adapter = channel('app', {
        liveUx: { typing: 'explicit', reactions: 'none' },
        setTyping,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
        settlementGraceMs: 10,
      });

      const start = liveUx.setTyping('app:conversation', true);
      await vi.advanceTimersByTimeAsync(20);
      await start;
      const stop = liveUx.setTyping('app:conversation', false);
      await vi.advanceTimersByTimeAsync(9);
      expect(setTyping).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await stop;

      expect(setTyping.mock.calls.map((call) => call[1])).toEqual([
        true,
        false,
      ]);
      expect(visibleEffects).toEqual([false]);
      expect(liveUx.pendingTargetCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a slow reaction add that lands after removal and grace', async () => {
    vi.useFakeTimers();
    try {
      let reactionVisible = false;
      const addReaction = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        reactionVisible = true;
      });
      const removeReaction = vi.fn(async () => {
        reactionVisible = false;
      });
      const adapter = channel('telegram', {
        liveUx: { typing: 'expiring', reactions: { removal: 'all' } },
        addReaction,
        removeReaction,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
        settlementGraceMs: 10,
      });

      const add = liveUx.addReaction('tg:42', '10', 'seen');
      await vi.advanceTimersByTimeAsync(20);
      await add;
      const removal = liveUx.removeReaction('tg:42', '10', 'seen');
      await vi.advanceTimersByTimeAsync(10);
      await removal;
      expect(reactionVisible).toBe(false);

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(addReaction).toHaveBeenCalledOnce();
      expect(removeReaction).toHaveBeenCalledTimes(2);
      expect(reactionVisible).toBe(false);
      expect(liveUx.pendingTargetCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bypasses a stale adapter cache when late removal settles after a newer add', async () => {
    vi.useFakeTimers();
    try {
      let reactionVisible = false;
      const methods: string[] = [];
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) => {
          methods.push(init?.method ?? '');
          if (init?.method === 'DELETE') {
            await new Promise((resolve) => setTimeout(resolve, 60));
            reactionVisible = false;
          } else {
            reactionVisible = true;
          }
          return new Response(null, { status: 204 });
        });
      const discord = new DiscordChannel('bot', 'app', {} as never);
      rememberDiscordReactionTarget(discord);
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(discord),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
        settlementGraceMs: 10,
      });

      await liveUx.addReaction('dc:42', 'message-1', 'seen');
      const removal = liveUx.removeReaction('dc:42', 'message-1', 'seen');
      await vi.advanceTimersByTimeAsync(30);
      await removal;
      await liveUx.addReaction('dc:42', 'message-1', 'seen');
      expect(reactionVisible).toBe(true);

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(methods).toEqual(['PUT', 'DELETE', 'PUT', 'PUT']);
      expect(reactionVisible).toBe(true);
      expect(liveUx.pendingTargetCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('serializes inverse Discord reactions resolved to one transport channel', async () => {
    let releaseAdd: (() => void) | undefined;
    const discord = new DiscordChannel('bot', 'app', {} as never);
    const messageChannelIds = Reflect.get(discord, 'messageChannelIds') as {
      remember(jid: string, messageRef: string, channelId: string): void;
    };
    messageChannelIds.remember('dc:parent', 'message-1', '123');
    messageChannelIds.remember('dc:123', 'message-1', '123');
    const addReaction = vi.spyOn(discord, 'addReaction').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAdd = resolve;
        }),
    );
    const removeReaction = vi
      .spyOn(discord, 'removeReaction')
      .mockResolvedValue(undefined);
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(discord),
      logger: { warn: vi.fn() },
    });

    const add = liveUx.addReaction('dc:123', 'message-1', 'seen');
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledOnce());
    const removal = liveUx.removeReaction('dc:parent', 'message-1', 'seen');
    await Promise.resolve();
    expect(removeReaction).not.toHaveBeenCalled();

    releaseAdd?.();
    await Promise.all([add, removal]);
    expect(removeReaction).toHaveBeenCalledOnce();
    expect(liveUx.pendingTargetCount()).toBe(0);
  });

  it('executes queued Discord work against the channel resolved for its lane', async () => {
    let releaseAdd: (() => void) | undefined;
    const urls: string[] = [];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (request, init) => {
        urls.push(String(request));
        if (init?.method === 'PUT') {
          await new Promise<void>((resolve) => {
            releaseAdd = resolve;
          });
        }
        return new Response(null, { status: 204 });
      });
    const discord = new DiscordChannel('bot', 'app', {} as never);
    const messageChannelIds = Reflect.get(discord, 'messageChannelIds') as {
      remember(jid: string, messageRef: string, channelId: string): void;
    };
    messageChannelIds.remember('dc:parent', 'message-1', '123');
    messageChannelIds.remember('dc:123', 'message-1', '123');
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(discord),
      logger: { warn: vi.fn() },
    });

    const add = liveUx.addReaction('dc:123', 'message-1', 'seen');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const removal = liveUx.removeReaction('dc:parent', 'message-1', 'seen');
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    messageChannelIds.remember('dc:parent', 'message-1', '999');
    releaseAdd?.();
    await Promise.all([add, removal]);

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('/channels/123/');
    expect(urls[1]).not.toContain('/channels/999/');
    expect(liveUx.pendingTargetCount()).toBe(0);
  });

  it('reconciles a slow typing start that lands after terminal off and grace', async () => {
    vi.useFakeTimers();
    try {
      let typingVisible = false;
      const setTyping = vi.fn(async (_jid: string, isTyping: boolean) => {
        if (isTyping) {
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        typingVisible = isTyping;
      });
      const adapter = channel('app', {
        liveUx: { typing: 'explicit', reactions: 'none' },
        setTyping,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
        settlementGraceMs: 10,
      });

      const start = liveUx.setTyping('app:conversation', true);
      await vi.advanceTimersByTimeAsync(20);
      await start;
      const stop = liveUx.setTyping('app:conversation', false);
      await vi.advanceTimersByTimeAsync(10);
      await stop;
      expect(typingVisible).toBe(false);

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(setTyping.mock.calls.map((call) => call[1])).toEqual([
        true,
        false,
        false,
      ]);
      expect(typingVisible).toBe(false);
      expect(liveUx.pendingTargetCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a slow terminal off that lands after a newer start and grace', async () => {
    vi.useFakeTimers();
    try {
      let typingVisible = false;
      const setTyping = vi.fn(async (_jid: string, isTyping: boolean) => {
        if (!isTyping) {
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        typingVisible = isTyping;
      });
      const adapter = channel('app', {
        liveUx: { typing: 'explicit', reactions: 'none' },
        setTyping,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
        settlementGraceMs: 10,
      });

      const start = liveUx.setTyping('app:conversation', true);
      await vi.advanceTimersByTimeAsync(1);
      await start;
      expect(typingVisible).toBe(true);

      const slowOff = liveUx.setTyping('app:conversation', false);
      await vi.advanceTimersByTimeAsync(30);
      await slowOff;

      const restart = liveUx.setTyping('app:conversation', true);
      await vi.advanceTimersByTimeAsync(1);
      await restart;
      expect(typingVisible).toBe(true);

      // The abandoned off now lands late; reconciliation must resend the
      // desired start even though explicit-typing suppression marks it active.
      await vi.advanceTimersByTimeAsync(60);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5);
      await Promise.resolve();
      await Promise.resolve();

      expect(typingVisible).toBe(true);
      expect(liveUx.pendingTargetCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reasserts the newest reaction after a timed-out fetch rejects on abort but commits late', async () => {
    vi.useFakeTimers();
    try {
      let reactionVisible = false;
      const addReaction = vi.fn(
        (_jid, _messageRef, _emoji, options) =>
          new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                reject(options.signal?.reason);
                setTimeout(() => {
                  reactionVisible = true;
                }, 20);
              },
              { once: true },
            );
          }),
      );
      const removeReaction = vi.fn(async () => {
        reactionVisible = false;
      });
      const adapter = channel('test', {
        liveUx: { typing: 'none', reactions: { removal: 'exact' } },
        addReaction,
        removeReaction,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn: vi.fn() },
        attemptDeadlineMs: 20,
        settlementGraceMs: 10,
        abandonedAttemptRetentionMs: 50,
      });

      const add = liveUx.addReaction('test:42', 'message-1', 'seen');
      await vi.advanceTimersByTimeAsync(20);
      await add;
      const removal = liveUx.removeReaction('test:42', 'message-1', 'seen');
      await vi.advanceTimersByTimeAsync(10);
      await removal;
      expect(reactionVisible).toBe(false);

      await vi.advanceTimersByTimeAsync(10);
      expect(reactionVisible).toBe(true);
      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();

      expect(removeReaction).toHaveBeenCalledTimes(2);
      expect(reactionVisible).toBe(false);
      expect(liveUx.retainedAbandonedAttemptCount()).toBe(0);
      expect(liveUx.retainedDesiredTargetCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps and expires retained state for repeated never-settling attempts', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const addReaction = vi.fn(async () => new Promise<void>(() => undefined));
      const adapter = channel('test', {
        liveUx: { typing: 'none', reactions: { removal: 'exact' } },
        addReaction,
      });
      const liveUx = createLiveUxDispatcher({
        findBinding: () => binding(adapter),
        logger: { warn },
        attemptDeadlineMs: 20,
        settlementGraceMs: 10,
        abandonedAttemptRetentionMs: 1_000,
        abandonedAttemptLimit: 2,
      });

      for (const messageRef of ['message-1', 'message-2', 'message-3']) {
        const delivery = liveUx.addReaction('test:42', messageRef, 'seen');
        await vi.advanceTimersByTimeAsync(30);
        await delivery;
      }

      expect(liveUx.pendingTargetCount()).toBe(0);
      expect(liveUx.retainedAbandonedAttemptCount()).toBe(2);
      expect(liveUx.retainedDesiredTargetCount()).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          abandonedAttemptEviction: 'limit',
          jid: 'test:42',
          messageRef: 'message-1',
        }),
        'Live UX abandoned attempt retention evicted',
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(liveUx.retainedAbandonedAttemptCount()).toBe(0);
      expect(liveUx.retainedDesiredTargetCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('declines a retry whose provider cooldown exceeds the bounded wait', async () => {
    const cause = new Error('rate limited');
    const addReaction = vi
      .fn()
      .mockRejectedValue(new LiveUxRateLimitError(21, cause));
    const wait = vi.fn(async () => undefined);
    const warn = vi.fn();
    const adapter = channel('test', {
      liveUx: { typing: 'none', reactions: { removal: 'exact' } },
      addReaction,
    });
    const liveUx = createLiveUxDispatcher({
      findBinding: () => binding(adapter),
      logger: { warn },
      attemptDeadlineMs: 20,
      wait,
    });

    await liveUx.addReaction('test:42', 'message-1', 'seen');

    expect(addReaction).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ retryDelayMs: 21 }),
      'Live UX retry declined: delay exceeds wait bound',
    );
    expect(liveUx.pendingTargetCount()).toBe(0);
  });
});
