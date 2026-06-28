import { describe, expect, it, vi } from 'vitest';

import type { NewMessage } from '@core/domain/types.js';
import { buildConversationContextPacket } from '@core/runtime/conversation-context.js';

function msg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'grp:1',
    sender: 'user:1',
    sender_name: 'User',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function sequence(count: number, make: (index: number) => Partial<NewMessage>) {
  return Array.from({ length: count }, (_, index) =>
    msg({
      id: `m-${index + 1}`,
      timestamp: `2024-01-01T00:${String(index + 1).padStart(2, '0')}:00.000Z`,
      ...make(index + 1),
    }),
  );
}

describe('buildConversationContextPacket', () => {
  it('selects mid-channel last 30 top-level messages plus the current message', async () => {
    const channelMessages = sequence(75, (index) => ({
      id: `channel-${index}`,
      content: `channel ${index}`,
    }));
    const current = channelMessages[54]!;
    const expectedRecent = channelMessages.slice(24, 54);
    const repository = {
      getRecentTopLevelMessagesBefore: vi
        .fn()
        .mockImplementation(
          async (
            _conversationJid: string,
            latestMessage: NewMessage,
            limit: number,
          ) =>
            channelMessages
              .filter(
                (message) =>
                  message.thread_id === undefined &&
                  message.timestamp < latestMessage.timestamp,
              )
              .slice(-limit),
        ),
      getFirstThreadMessages: vi.fn(),
      getLatestThreadMessages: vi.fn(),
    };

    const packet = await buildConversationContextPacket({
      conversationJid: 'grp:1',
      latestMessage: current,
      currentMessages: [current],
      repository,
    });

    expect(repository.getRecentTopLevelMessagesBefore).toHaveBeenCalledWith(
      'grp:1',
      current,
      30,
    );
    expect(packet.recentChannelContext.map((message) => message.id)).toEqual(
      expectedRecent.map((message) => message.id),
    );
    expect(packet.currentMessages).toEqual([current]);
    expect(packet.activeThreadContext).toEqual([]);
  });

  it('selects thread root and prior messages through the same-thread repository contract', async () => {
    const current = msg({
      id: 'current',
      thread_id: 'thread-1',
      content: '@Gantry summarize',
      timestamp: '2024-01-01T00:04:00.000Z',
    });
    const root = msg({
      id: 'root',
      external_message_id: 'thread-1',
      thread_id: 'thread-1',
      content: 'root',
      timestamp: '2024-01-01T00:01:00.000Z',
    });
    const prior = msg({
      id: 'prior',
      thread_id: 'thread-1',
      content: 'prior',
      timestamp: '2024-01-01T00:02:00.000Z',
    });
    const unrelated = msg({
      id: 'other',
      thread_id: 'thread-2',
      content: 'other',
      timestamp: '2024-01-01T00:03:00.000Z',
    });
    const storedThreadMessages = [root, prior, unrelated, current];
    const repository = {
      getRecentTopLevelMessagesBefore: vi.fn().mockResolvedValue([]),
      getFirstThreadMessages: vi
        .fn()
        .mockImplementation(
          async (_conversationJid: string, threadId: string, limit: number) =>
            storedThreadMessages
              .filter((message) => message.thread_id === threadId)
              .slice(0, limit),
        ),
      getLatestThreadMessages: vi
        .fn()
        .mockImplementation(
          async (
            _conversationJid: string,
            threadId: string,
            latestMessage: NewMessage,
            limit: number,
          ) =>
            storedThreadMessages
              .filter(
                (message) =>
                  message.thread_id === threadId &&
                  message.timestamp <= latestMessage.timestamp,
              )
              .slice(-limit),
        ),
    };

    const packet = await buildConversationContextPacket({
      conversationJid: 'grp:1',
      activeThreadId: 'thread-1',
      latestMessage: current,
      currentMessages: [current],
      repository,
    });

    expect(repository.getFirstThreadMessages).toHaveBeenCalledWith(
      'grp:1',
      'thread-1',
      11,
    );
    expect(repository.getLatestThreadMessages).toHaveBeenCalledWith(
      'grp:1',
      'thread-1',
      current,
      50,
    );
    expect(packet.activeThreadContext.map((message) => message.id)).toEqual([
      'root',
      'prior',
    ]);
    expect(
      packet.activeThreadContext.map((message) => message.thread_id),
    ).toEqual(['thread-1', 'thread-1']);
    expect(packet.metadata.activeThreadRootPresent).toBe(true);
  });

  it('excludes first-window thread replies after the triggering message cursor', async () => {
    const root = msg({
      id: 'root',
      external_message_id: 'thread-1',
      thread_id: 'thread-1',
      content: 'root',
      timestamp: '2024-01-01T00:01:00.000Z',
    });
    const prior = msg({
      id: 'prior',
      thread_id: 'thread-1',
      content: 'prior',
      timestamp: '2024-01-01T00:02:00.000Z',
    });
    const current = msg({
      id: 'current',
      thread_id: 'thread-1',
      content: '@Gantry summarize',
      timestamp: '2024-01-01T00:03:00.000Z',
    });
    const futureFromFirstWindow = msg({
      id: 'future-from-first-window',
      thread_id: 'thread-1',
      content: 'future reply',
      timestamp: '2024-01-01T00:04:00.000Z',
    });
    const repository = {
      getRecentTopLevelMessagesBefore: vi.fn().mockResolvedValue([]),
      getFirstThreadMessages: vi
        .fn()
        .mockResolvedValue([root, prior, futureFromFirstWindow]),
      getLatestThreadMessages: vi
        .fn()
        .mockResolvedValue([root, prior, current]),
    };

    const packet = await buildConversationContextPacket({
      conversationJid: 'grp:1',
      activeThreadId: 'thread-1',
      latestMessage: current,
      currentMessages: [current],
      repository,
    });

    expect(packet.activeThreadContext.map((message) => message.id)).toEqual([
      'root',
      'prior',
    ]);
    expect(packet.activeThreadContext).not.toContain(futureFromFirstWindow);
    expect(packet.metadata.activeThreadRootPresent).toBe(true);
  });

  it('does not mark a full before-or-at thread window complete after excluding the current message', async () => {
    const threadMessages = sequence(50, (index) => ({
      id: index === 50 ? 'current' : `thread-${index}`,
      thread_id: 'thread-1',
      content: index === 50 ? '@Gantry summarize' : `thread ${index}`,
    }));
    const current = threadMessages[49]!;
    const repository = {
      getRecentTopLevelMessagesBefore: vi.fn().mockResolvedValue([]),
      getFirstThreadMessages: vi
        .fn()
        .mockResolvedValue(threadMessages.slice(0, 11)),
      getLatestThreadMessages: vi.fn().mockResolvedValue(threadMessages),
    };

    const packet = await buildConversationContextPacket({
      conversationJid: 'grp:1',
      activeThreadId: 'thread-1',
      latestMessage: current,
      currentMessages: [current],
      repository,
    });

    expect(repository.getLatestThreadMessages).toHaveBeenCalledWith(
      'grp:1',
      'thread-1',
      current,
      50,
    );
    expect(packet.activeThreadContext).toHaveLength(49);
    expect(packet.activeThreadContext.map((message) => message.id)).toEqual(
      Array.from({ length: 49 }, (_, index) => `thread-${index + 1}`),
    );
    expect(packet.activeThreadContext).not.toContain(current);
    expect(packet.metadata.activeThreadCount).toBe(49);
    expect(packet.metadata.activeThreadWindowComplete).toBe(false);
  });

  it('bounds long threads to root plus first 10 replies and latest 39 replies deterministically without duplicates', async () => {
    const threadMessages = sequence(70, (index) => ({
      id: `thread-${index}`,
      thread_id: 'thread-1',
      content: `thread ${index}`,
    }));
    const current = threadMessages[69]!;
    const repository = {
      getRecentTopLevelMessagesBefore: vi.fn().mockResolvedValue([]),
      getFirstThreadMessages: vi
        .fn()
        .mockResolvedValue([
          ...threadMessages.slice(0, 11).reverse(),
          threadMessages[3],
        ]),
      getLatestThreadMessages: vi
        .fn()
        .mockResolvedValue([
          ...threadMessages.slice(20).reverse(),
          threadMessages[10],
        ]),
    };

    const packet = await buildConversationContextPacket({
      conversationJid: 'grp:1',
      activeThreadId: 'thread-1',
      latestMessage: current,
      currentMessages: [current],
      repository,
    });

    expect(packet.activeThreadContext).toHaveLength(50);
    expect(packet.activeThreadContext.map((message) => message.id)).toEqual([
      'thread-1',
      ...Array.from({ length: 10 }, (_, index) => `thread-${index + 2}`),
      ...Array.from({ length: 39 }, (_, index) => `thread-${index + 31}`),
    ]);
    expect(new Set(packet.activeThreadContext.map((m) => m.id)).size).toBe(50);
    expect(packet.activeThreadContext.at(-1)?.id).toBe('thread-69');
    expect(packet.currentMessages).toEqual([current]);
    expect(packet.metadata.activeThreadRootPresent).toBe(true);
  });

  it('does not treat reply windows without explicit root ids as root-present', async () => {
    const replies = sequence(50, (index) => ({
      id: `reply-${index}`,
      external_message_id: `provider-reply-${index}`,
      thread_id: 'thread-1',
      content: `reply ${index}`,
    }));
    const current = msg({
      id: 'current',
      external_message_id: 'provider-current',
      thread_id: 'thread-1',
      content: '@Gantry summarize',
      timestamp: '2024-01-01T00:51:00.000Z',
    });
    const repository = {
      getRecentTopLevelMessagesBefore: vi.fn().mockResolvedValue([]),
      getFirstThreadMessages: vi.fn().mockResolvedValue(replies.slice(0, 11)),
      getLatestThreadMessages: vi.fn().mockResolvedValue(replies),
    };

    const packet = await buildConversationContextPacket({
      conversationJid: 'grp:1',
      activeThreadId: 'thread-1',
      latestMessage: current,
      currentMessages: [current],
      repository,
    });

    expect(packet.activeThreadContext).toHaveLength(50);
    expect(packet.metadata.activeThreadWindowComplete).toBe(true);
    expect(packet.metadata.activeThreadRootPresent).toBe(false);
  });

  it('detects an actual thread root from the provider root id', async () => {
    const root = msg({
      id: 'local-root',
      external_message_id: 'thread-1',
      thread_id: 'thread-1',
      content: 'root',
      timestamp: '2024-01-01T00:01:00.000Z',
    });
    const current = msg({
      id: 'current',
      external_message_id: 'provider-current',
      thread_id: 'thread-1',
      reply_to_message_id: 'thread-1',
      content: '@Gantry summarize',
      timestamp: '2024-01-01T00:02:00.000Z',
    });
    const repository = {
      getRecentTopLevelMessagesBefore: vi.fn().mockResolvedValue([]),
      getFirstThreadMessages: vi.fn().mockResolvedValue([root]),
      getLatestThreadMessages: vi.fn().mockResolvedValue([root, current]),
    };

    const packet = await buildConversationContextPacket({
      conversationJid: 'grp:1',
      activeThreadId: 'thread-1',
      latestMessage: current,
      currentMessages: [current],
      repository,
    });

    expect(packet.activeThreadContext).toEqual([root]);
    expect(packet.metadata.activeThreadRootPresent).toBe(true);
  });
});
