import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mockGetNewMessages = vi.fn();
const mockGetMessagesSince = vi.fn();
const mockGetMessageThreadIds = vi.fn();
const mockGetTriggerPattern = vi.fn();
const mockLoadSenderAllowlist = vi.fn();
const mockLoadSenderControlAllowlist = vi.fn();
const mockIsSenderExplicitlyAllowed = vi.fn();
const mockIsSenderControlAllowed = vi.fn();
const mockIsTriggerAllowed = vi.fn();
const mockExtractSessionCommand = vi.fn();
const mockIsSessionCommandAllowed = vi.fn();
const mockFormatMessages = vi.fn();

vi.mock('@core/config/index.js', () => ({
  getTriggerPattern: (...args: unknown[]) => mockGetTriggerPattern(...args),
  POLL_INTERVAL: 100,
  MAX_MESSAGES_PER_PROMPT: 50,
  TIMEZONE: 'UTC',
}));
vi.mock('@core/platform/sender-allowlist.js', () => ({
  loadSenderAllowlist: (...args: unknown[]) => mockLoadSenderAllowlist(...args),
  loadSenderControlAllowlist: (...args: unknown[]) =>
    mockLoadSenderControlAllowlist(...args),
  isSenderExplicitlyAllowed: (...args: unknown[]) =>
    mockIsSenderExplicitlyAllowed(...args),
  isSenderControlAllowed: (...args: unknown[]) =>
    mockIsSenderControlAllowed(...args),
  isTriggerAllowed: (...args: unknown[]) => mockIsTriggerAllowed(...args),
}));
vi.mock('@core/session/session-commands.js', () => ({
  extractSessionCommand: (...args: unknown[]) =>
    mockExtractSessionCommand(...args),
  isSessionCommandAllowed: (...args: unknown[]) =>
    mockIsSessionCommandAllowed(...args),
}));
vi.mock('@core/messaging/router.js', () => ({
  formatMessages: (...args: unknown[]) => mockFormatMessages(...args),
}));

import {
  MessageLoopDeps,
  recoverPendingMessages,
} from '@core/runtime/message-loop.js';
import { decodeGroupMessageCursor } from '@core/shared/message-cursor.js';
import { ConversationRoute } from '@core/domain/types.js';

function makeDeps(overrides: Partial<MessageLoopDeps> = {}): MessageLoopDeps & {
  enqueued: string[];
  cursors: Record<string, string>;
  sentTo: string[];
  closedStdin: string[];
  stoppedGroups: string[];
  savedCount: number;
} {
  const enqueued: string[] = [];
  const cursors: Record<string, string> = {};
  const sentTo: string[] = [];
  const closedStdin: string[] = [];
  const stoppedGroups: string[] = [];
  let savedCount = 0;
  const opsRepository = {
    getNewMessages: (...args: unknown[]) => mockGetNewMessages(...args),
    getMessagesSince: (...args: unknown[]) => mockGetMessagesSince(...args),
    getMessageThreadIds: (...args: unknown[]) =>
      mockGetMessageThreadIds(...args),
  } as unknown as MessageLoopDeps['opsRepository'];

  const deps: MessageLoopDeps & {
    enqueued: string[];
    cursors: Record<string, string>;
    sentTo: string[];
    closedStdin: string[];
    stoppedGroups: string[];
    savedCount: number;
  } = {
    assistantName: 'Andy',
    getConversationRoutes: () => ({
      'group@g.us': {
        name: 'Team',
        folder: 'team',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    }),
    getLastTimestamp: () => '2024-01-01T00:00:00.000Z',
    setLastTimestamp: vi.fn(),
    getOrRecoverCursor: (chatJid: string) =>
      cursors[chatJid] || '2024-01-01T00:00:00.000Z',
    setAgentCursor: (chatJid: string, ts: string) => {
      cursors[chatJid] = ts;
    },
    saveState: () => {
      savedCount += 1;
    },
    hasChannel: () => true,
    setTyping: vi.fn().mockResolvedValue(undefined),
    sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
    queue: {
      sendMessage: (chatJid: string) => {
        sentTo.push(chatJid);
        return true;
      },
      enqueueMessageCheck: (chatJid: string) => {
        enqueued.push(chatJid);
      },
      closeStdin: (chatJid: string) => {
        closedStdin.push(chatJid);
      },
      stopGroup: (chatJid: string) => {
        stoppedGroups.push(chatJid);
        return true;
      },
    },
    opsRepository,
    enqueued,
    cursors,
    sentTo,
    closedStdin,
    stoppedGroups,
    savedCount,
    ...overrides,
  };
  return deps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNewMessages.mockReturnValue({ messages: [], newTimestamp: '' });
  mockGetMessagesSince.mockReturnValue([]);
  mockGetMessageThreadIds.mockReturnValue([null]);
  mockGetTriggerPattern.mockReturnValue(/@Andy/i);
  mockLoadSenderAllowlist.mockReturnValue({});
  mockLoadSenderControlAllowlist.mockReturnValue({});
  mockIsSenderExplicitlyAllowed.mockReturnValue(false);
  mockIsSenderControlAllowed.mockReturnValue(false);
  mockIsTriggerAllowed.mockReturnValue(true);
  mockExtractSessionCommand.mockReturnValue(null);
  mockIsSessionCommandAllowed.mockReturnValue(false);
  mockFormatMessages.mockReturnValue('formatted messages');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recoverPendingMessages', () => {
  it('enqueues message checks for groups with pending messages', async () => {
    mockGetMessagesSince.mockReturnValue([
      {
        id: 1,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        content: 'hello',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_from_me: false,
        message_id: 'msg-1',
        reply_to_message_id: null,
        reply_to_content: null,
        sender_name: 'User',
      },
    ]);

    const deps = makeDeps();
    await recoverPendingMessages(deps);

    expect(deps.enqueued).toContain('group@g.us');
  });

  it('does not enqueue when no pending messages exist', async () => {
    mockGetMessagesSince.mockReturnValue([]);

    const deps = makeDeps();
    await recoverPendingMessages(deps);

    expect(deps.enqueued).toHaveLength(0);
  });

  it('recovers pending thread messages using the thread cursor, not the root cursor', async () => {
    mockGetMessageThreadIds.mockReturnValue([null, 'topic-1']);
    mockGetMessagesSince.mockImplementation(
      (_chatJid: string, cursor: string, _limit: number, options: any) => {
        if (options?.threadId === 'topic-1') {
          expect(cursor).toBe('');
          return [
            {
              id: 2,
              chat_jid: 'group@g.us',
              sender: 'user@s.whatsapp.net',
              content: 'pending thread message',
              timestamp: '2024-01-01T00:00:01.000Z',
              thread_id: 'topic-1',
              is_from_me: false,
              message_id: 'msg-2',
              reply_to_message_id: null,
              reply_to_content: null,
              sender_name: 'User',
            },
          ];
        }
        expect(cursor).toBe('root-cursor');
        return [];
      },
    );

    const deps = makeDeps({
      getOrRecoverCursor: (queueJid: string) =>
        queueJid.includes('::thread:') ? '' : 'root-cursor',
    });
    await recoverPendingMessages(deps);

    expect(deps.enqueued).toEqual(['group@g.us::thread:topic-1']);
  });

  it('checks all registered groups', async () => {
    mockGetMessagesSince.mockReturnValue([
      {
        id: 1,
        chat_jid: 'group1@g.us',
        sender: 'user@s.whatsapp.net',
        content: 'hello',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_from_me: false,
        message_id: 'msg-1',
        reply_to_message_id: null,
        reply_to_content: null,
        sender_name: 'User',
      },
    ]);

    const deps = makeDeps({
      getConversationRoutes: () => ({
        'group1@g.us': {
          name: 'Team 1',
          folder: 'team1',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: false,
        },
        'group2@g.us': {
          name: 'Team 2',
          folder: 'team2',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: false,
        },
      }),
    });

    await recoverPendingMessages(deps);
    expect(deps.enqueued).toEqual(['group1@g.us', 'group2@g.us']);
  });
});

describe('thread queue routing', () => {
  it('enqueues separate queue keys for Slack/Telegram thread messages', async () => {
    const threadA = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'thread A',
      timestamp: '2024-01-01T00:00:01.000Z',
      thread_id: 'thread-a',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };
    const threadB = {
      ...threadA,
      id: 2,
      content: 'thread B',
      timestamp: '2024-01-01T00:00:02.000Z',
      thread_id: 'thread-b',
      message_id: 'msg-2',
    };
    mockGetNewMessages.mockReturnValueOnce({
      messages: [threadA, threadB],
      newTimestamp: '2024-01-01T00:00:02.000Z',
    });
    mockGetMessagesSince.mockImplementation(
      (
        _chatJid: string,
        _cursor: string,
        _limit: number,
        options?: {
          threadId?: string | null;
        },
      ) => {
        if (options?.threadId === 'thread-a') return [threadA];
        if (options?.threadId === 'thread-b') return [threadB];
        return [];
      },
    );

    const enqueued: string[] = [];
    const deps = makeDeps({
      queue: {
        ...makeDeps().queue,
        sendMessage: () => false,
        enqueueMessageCheck: (queueJid: string) => enqueued.push(queueJid),
      },
    });
    const { runMessagePollingTick } =
      await import('@core/runtime/message-loop.js');

    await runMessagePollingTick(deps);

    expect(enqueued).toEqual([
      'group@g.us::thread:thread-a',
      'group@g.us::thread:thread-b',
    ]);
  });

  it('passes non-self sender ids with continuation batches', async () => {
    const first = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'sl:UADMIN',
      content: 'approve 1',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'Admin',
    };
    const second = {
      ...first,
      id: 2,
      sender: 'sl:UOTHER',
      content: 'approve 2',
      timestamp: '2024-01-01T00:00:02.000Z',
      message_id: 'msg-2',
      sender_name: 'Other',
    };
    mockGetNewMessages.mockReturnValueOnce({
      messages: [first, second],
      newTimestamp: '2024-01-01T00:00:02.000Z',
    });
    mockGetMessagesSince.mockReturnValue([first, second]);

    const sendMessage = vi.fn(() => true);
    const deps = makeDeps({
      queue: {
        ...makeDeps().queue,
        sendMessage,
      },
    });
    const { runMessagePollingTick } =
      await import('@core/runtime/message-loop.js');

    await runMessagePollingTick(deps);

    expect(sendMessage).toHaveBeenCalledWith(
      'group@g.us',
      'formatted messages',
      {
        threadId: undefined,
        senderUserIds: ['sl:UADMIN', 'sl:UOTHER'],
        idempotencyKey: 'continuation:group@g.us:1,2',
        cursorAfter: expect.any(String),
      },
    );
  });

  it('passes the exact thread queue key to active control commands', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy /stop',
      timestamp: '2024-01-01T00:00:01.000Z',
      thread_id: 'thread-b',
      is_from_me: false,
      sender_name: 'User',
    };
    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockExtractSessionCommand.mockReturnValue({ kind: 'stop', raw: '/stop' });
    mockIsSessionCommandAllowed.mockReturnValue(true);

    const handleActiveControlCommand = vi.fn(() => true);
    const deps = makeDeps({ handleActiveControlCommand });
    const { runMessagePollingTick } =
      await import('@core/runtime/message-loop.js');

    await runMessagePollingTick(deps);

    expect(handleActiveControlCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'group@g.us',
        queueJid: 'group@g.us::thread:thread-b',
      }),
    );
    expect(deps.stoppedGroups).toHaveLength(0);
  });
});

describe('startMessagePollingLoop', () => {
  it('processes new messages and pipes them to the queue', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    // Run one iteration then abort
    const controller = new AbortController();
    const loopPromise = startMessagePollingLoop(deps);

    // Give it time to process one iteration
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toContain('group@g.us');
    expect(decodeGroupMessageCursor(deps.cursors['group@g.us'])).toEqual({
      timestamp: '2024-01-01T00:00:01.000Z',
      id: '1',
    });

    // We can't cleanly stop the infinite loop in tests, so we just verify behavior
    // The loop will be cleaned up when the test ends
  });

  it('skips groups with no channel', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });

    const deps = makeDeps({ hasChannel: () => false });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
  });

  it('enqueues message check when sendMessage returns false', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const deps = makeDeps({
      queue: {
        sendMessage: () => false,
        enqueueMessageCheck: (jid: string) => deps.enqueued.push(jid),
        closeStdin: () => {},
      },
    });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.enqueued).toContain('group@g.us');
  });

  it('handles session commands by closing stdin and enqueuing', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy /new',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockExtractSessionCommand.mockReturnValue('/new');
    mockIsSessionCommandAllowed.mockReturnValue(true);

    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.closedStdin).toContain('group@g.us');
    expect(deps.enqueued).toContain('group@g.us');
  });

  it('handles /stop by stopping the active run and enqueuing', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy /stop',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockExtractSessionCommand.mockReturnValue({ kind: 'stop', raw: '/stop' });
    mockIsSessionCommandAllowed.mockReturnValue(true);

    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.stoppedGroups).toContain('group@g.us');
    expect(deps.closedStdin).toHaveLength(0);
    expect(deps.enqueued).toContain('group@g.us');
  });

  it('skips trigger-required conversations without trigger match', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello no trigger',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetTriggerPattern.mockReturnValue(/@Andy/i);

    const deps = makeDeps({
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
  });

  it('recovers from errors in the loop body', async () => {
    // First call throws, second returns empty
    mockGetNewMessages
      .mockImplementationOnce(() => {
        throw new Error('db connection lost');
      })
      .mockReturnValue({ messages: [], newTimestamp: '' });

    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 250));

    // Loop should survive the error and keep running
    expect(mockGetNewMessages.mock.calls.length).toBeGreaterThan(1);
  });

  it('groups multiple messages by chat_jid (covers existing.push branch)', async () => {
    const msg1 = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user1@s.whatsapp.net',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User1',
    };
    const msg2 = {
      id: '2',
      chat_jid: 'group@g.us',
      sender: 'user2@s.whatsapp.net',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
      sender_name: 'User2',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg1, msg2],
      newTimestamp: '2024-01-01T00:00:02.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg1, msg2]);

    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // Both messages were grouped under the same JID and sent together
    expect(deps.sentTo).toContain('group@g.us');
    // Cursor set to last message timestamp
    expect(decodeGroupMessageCursor(deps.cursors['group@g.us'])).toEqual({
      timestamp: '2024-01-01T00:00:02.000Z',
      id: '2',
    });
  });

  it('catches setTyping rejection without crashing the loop', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const setTypingMock = vi.fn().mockRejectedValue(new Error('typing failed'));
    const deps = makeDeps({
      setTyping: setTypingMock,
    });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // setTyping was called and rejected, but the loop survived
    expect(setTypingMock).toHaveBeenCalledWith('group@g.us', true);
    expect(deps.sentTo).toContain('group@g.us');
  });

  it('sets typing when piping to active agent run and leaves progress to the run owner', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello again',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const sendProgressUpdateMock = vi.fn().mockResolvedValue(undefined);
    const setTypingMock = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      setTyping: setTypingMock,
      sendProgressUpdate: sendProgressUpdateMock,
    });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(setTypingMock).toHaveBeenCalledWith('group@g.us', true);
    expect(sendProgressUpdateMock).not.toHaveBeenCalled();
  });

  it('skips groups not in conversationRoutes', async () => {
    const msg = {
      id: '1',
      chat_jid: 'unknown@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });

    // The registered groups only contain group@g.us, not unknown@g.us
    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
    expect(deps.enqueued).toHaveLength(0);
  });

  it('enqueues without closeStdin when session command is not allowed', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy /new',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockExtractSessionCommand.mockReturnValue('/new');
    mockIsSessionCommandAllowed.mockReturnValue(false);

    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // closeStdin should NOT be called when the command is not allowed
    expect(deps.closedStdin).toHaveLength(0);
    // But enqueue should still happen
    expect(deps.enqueued).toContain('group@g.us');
  });

  it('uses fallback groupMessages when getMessagesSince returns empty', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    // allPending is empty, so messagesToSend falls back to groupMessages
    mockGetMessagesSince.mockReturnValue([]);

    const deps = makeDeps();
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // formatMessages should be called with the original groupMessages
    expect(mockFormatMessages).toHaveBeenCalledWith([msg], 'UTC');
    expect(deps.sentTo).toContain('group@g.us');
  });

  it('processes conversation-scoped group when trigger matches and sender is allowed', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy do something',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);
    mockGetTriggerPattern.mockReturnValue(/^@Andy\b/i);
    mockIsTriggerAllowed.mockReturnValue(true);

    const deps = makeDeps({
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          // requiresTrigger not set defaults to needing trigger.
        },
      }),
    });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toContain('group@g.us');
  });

  it('processes conversation-scoped group with requiresTrigger=false without trigger', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello no trigger',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const deps = makeDeps({
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: false,
        },
      }),
    });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toContain('group@g.us');
  });

  it('skips conversation-scoped group when trigger matches but sender is not allowed (not from me)', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy do something',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetTriggerPattern.mockReturnValue(/^@Andy\b/i);
    mockIsTriggerAllowed.mockReturnValue(false);

    const deps = makeDeps({
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
  });

  it('stop() exits the loop promptly: no further polling ticks after stop', async () => {
    mockGetNewMessages.mockReturnValue({
      messages: [],
      newTimestamp: '',
    });

    // Count ticks through a deps-scoped spy: getLastTimestamp runs once per
    // tick, and unlike the shared module mocks it is not touched by polling
    // loops leaked from earlier tests in this file.
    const getLastTimestamp = vi.fn(() => '');
    const deps = makeDeps({ getLastTimestamp });
    const { startMessagePollingLoop } =
      await import('@core/runtime/message-loop.js');

    const loop = startMessagePollingLoop(deps);
    // Let the first tick complete, then stop during the poll delay.
    await new Promise((r) => setTimeout(r, 20));
    loop.stop();
    await loop.done;

    const ticksAtStop = getLastTimestamp.mock.calls.length;
    expect(ticksAtStop).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(getLastTimestamp.mock.calls.length).toBe(ticksAtStop);
  });
});
