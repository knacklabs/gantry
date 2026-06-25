import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
  MAX_MESSAGES_PER_PROMPT: 10,
  MESSAGE_FETCH_PAGE_SIZE: 50,
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
import {
  decodeGroupMessageCursor,
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '@core/shared/message-cursor.js';
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

function makePendingMessage(index: number) {
  const timestamp = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString();
  return {
    id: String(index),
    chat_jid: 'group@g.us',
    sender: `user-${index}@s.whatsapp.net`,
    content: `message ${index}`,
    timestamp,
    is_from_me: false,
    message_id: `msg-${index}`,
    reply_to_message_id: null,
    reply_to_content: null,
    sender_name: `User ${index}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it('keeps the repository receiver when replaying pending messages', async () => {
    const repo = {
      messages: [
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
      ],
      async getMessagesSince() {
        return this.messages;
      },
      async getMessageThreadIds() {
        return [null];
      },
    } as unknown as MessageLoopDeps['opsRepository'];

    const deps = makeDeps({ opsRepository: repo });
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
  it('processes a durable live admission item without route-wide scans', async () => {
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
    mockGetMessagesSince.mockReturnValueOnce([msg]);
    const enqueued: string[] = [];
    const deps = makeDeps({
      queue: {
        ...makeDeps().queue,
        sendMessage: () => false,
        enqueueMessageCheck: (queueJid: string) => {
          enqueued.push(queueJid);
          return true;
        },
      },
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-1',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: null,
        queueJid: 'group@g.us',
        messageId: 'message:group@g.us:1',
        messageCursor: '2024-01-01T00:00:01.000Z::1',
        senderUserId: 'user@s.whatsapp.net',
        senderDisplayName: 'User',
        idempotencyKey: 'provider:msg-1',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:01.000Z',
        updatedAt: '2024-01-01T00:00:01.000Z',
        claimedAt: '2024-01-01T00:00:01.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(mockGetMessagesSince).toHaveBeenCalledOnce();
    expect(enqueued).toEqual(['group@g.us']);
  });

  it('loads a durable route before processing a claimed live admission item', async () => {
    const msg = {
      id: 'sdk-msg-1',
      chat_jid: 'app:app-one:conv-new',
      sender: 'external-ingress',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'sdk-msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'External Ingress',
    };
    mockGetMessagesSince.mockReturnValueOnce([msg]);
    const routes: Record<string, ConversationRoute> = {};
    const getConversationRoute = vi.fn(async () => ({
      name: 'New SDK Session',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
    }));
    const deps = makeDeps({
      getConversationRoutes: () => routes,
      opsRepository: {
        getMessagesSince: (...args: unknown[]) => mockGetMessagesSince(...args),
        getMessageThreadIds: (...args: unknown[]) =>
          mockGetMessageThreadIds(...args),
        getConversationRoute,
      } as unknown as MessageLoopDeps['opsRepository'],
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-new-session',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'app:app-one:conv-new',
        threadId: null,
        queueJid: 'app:app-one:conv-new',
        messageId: 'message:app:app-one:conv-new:sdk-msg-1',
        messageCursor: '2024-01-01T00:00:01.000Z::sdk-msg-1',
        senderUserId: 'external-ingress',
        senderDisplayName: 'External Ingress',
        idempotencyKey: 'external-ingress:sdk-msg-1',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:01.000Z',
        updatedAt: '2024-01-01T00:00:01.000Z',
        claimedAt: '2024-01-01T00:00:01.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(getConversationRoute).toHaveBeenCalledWith('app:app-one:conv-new');
    expect(routes['app:app-one:conv-new']).toMatchObject({
      folder: 'main',
    });
    expect(deps.sentTo).toEqual(['app:app-one:conv-new']);
  });

  it('routes one bounded durable pending-message window and schedules the next pass', async () => {
    const messages = Array.from({ length: 1_001 }, (_, index) =>
      makePendingMessage(index + 1),
    );
    let offset = 0;
    mockGetMessagesSince.mockImplementation((_chatJid, _cursor, limit = 50) => {
      const batch = messages.slice(offset, offset + Number(limit));
      offset += batch.length;
      return batch;
    });
    const sendMessage = vi.fn(() => true);
    const deps = makeDeps();
    deps.queue.sendMessage = sendMessage;
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-1',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: null,
        queueJid: 'group@g.us',
        messageId: 'message:group@g.us:1001',
        messageCursor: '2024-01-01T00:16:41.000Z::1001',
        senderUserId: 'user-1001@s.whatsapp.net',
        senderDisplayName: 'User 51',
        idempotencyKey: 'provider:msg-51',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:51.000Z',
        updatedAt: '2024-01-01T00:00:51.000Z',
        claimedAt: '2024-01-01T00:00:51.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(mockGetMessagesSince).toHaveBeenCalledTimes(1);
    expect(mockFormatMessages).toHaveBeenCalledWith(
      messages.slice(0, 10),
      'UTC',
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][2]).toMatchObject({
      cursorAfter: JSON.stringify({
        timestamp: '2024-01-01T00:00:10.000Z',
        id: '10',
      }),
    });
    expect(deps.cursors['group@g.us']).toBe(
      JSON.stringify({
        timestamp: '2024-01-01T00:00:10.000Z',
        id: '10',
      }),
    );
    expect(deps.enqueued).toEqual(['group@g.us']);
  });

  it('advances handled command replay windows before requeueing', async () => {
    const messages = Array.from({ length: 1_001 }, (_, index) =>
      makePendingMessage(index + 1),
    );
    messages[0] = { ...messages[0], content: '@Andy /stop' };
    let offset = 0;
    mockGetMessagesSince.mockImplementation((_chatJid, _cursor, limit = 50) => {
      const batch = messages.slice(offset, offset + Number(limit));
      offset += batch.length;
      return batch;
    });
    mockExtractSessionCommand.mockImplementation((content: string) =>
      content.includes('/stop') ? { kind: 'stop', raw: '/stop' } : null,
    );
    mockIsSessionCommandAllowed.mockReturnValue(true);
    mockIsSenderControlAllowed.mockReturnValue(true);
    const saveState = vi.fn();
    const handleActiveControlCommand = vi.fn(async (args) => {
      deps.setAgentCursor(
        args.queueJid,
        encodeGroupMessageCursor(toGroupMessageCursor(args.message)),
      );
      await saveState();
      return true;
    });
    const deps = makeDeps({
      handleActiveControlCommand,
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-1',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: null,
        queueJid: 'group@g.us',
        messageId: 'message:group@g.us:1001',
        messageCursor: '2024-01-01T00:16:41.000Z::1001',
        senderUserId: 'user-1001@s.whatsapp.net',
        senderDisplayName: 'User 51',
        idempotencyKey: 'provider:msg-51',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:51.000Z',
        updatedAt: '2024-01-01T00:00:51.000Z',
        claimedAt: '2024-01-01T00:00:51.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(handleActiveControlCommand).toHaveBeenCalledOnce();
    expect(decodeGroupMessageCursor(deps.cursors['group@g.us'])).toEqual({
      timestamp: '2024-01-01T00:00:01.000Z',
      id: '1',
    });
    expect(saveState).toHaveBeenCalledOnce();
    expect(deps.enqueued).toEqual(['group@g.us']);
  });

  it('advances ignored no-trigger replay windows before requeueing', async () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      ...makePendingMessage(index + 1),
      content: 'no trigger here',
    }));
    let offset = 0;
    mockGetMessagesSince.mockImplementation((_chatJid, _cursor, limit = 50) => {
      const batch = messages.slice(offset, offset + Number(limit));
      offset += batch.length;
      return batch;
    });
    const saveState = vi.fn();
    const deps = makeDeps({
      saveState,
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: true,
        },
      }),
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-1',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: null,
        queueJid: 'group@g.us',
        messageId: 'message:group@g.us:1000',
        messageCursor: '2024-01-01T00:16:40.000Z::1000',
        senderUserId: 'user-1000@s.whatsapp.net',
        senderDisplayName: 'User 1000',
        idempotencyKey: 'provider:msg-1000',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:51.000Z',
        updatedAt: '2024-01-01T00:00:51.000Z',
        claimedAt: '2024-01-01T00:00:51.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(mockGetMessagesSince).toHaveBeenCalledTimes(1);
    expect(deps.sentTo).toHaveLength(0);
    expect(deps.enqueued).toEqual(['group@g.us']);
    expect(decodeGroupMessageCursor(deps.cursors['group@g.us'])).toEqual({
      timestamp: '2024-01-01T00:00:10.000Z',
      id: '10',
    });
    expect(saveState).toHaveBeenCalledOnce();
  });

  it('ignores untagged messages in a new thread when the parent conversation requires a trigger', async () => {
    const message = {
      ...makePendingMessage(1),
      content: 'this thread is for humans',
      thread_id: 'thread-1',
    };
    mockGetMessagesSince.mockReturnValueOnce([message]);
    const saveState = vi.fn();
    const deps = makeDeps({
      saveState,
      getOrRecoverCursor: (queueJid: string) =>
        queueJid.includes('::thread:') ? '' : 'root-cursor',
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: true,
        },
      }),
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-thread-1',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: 'thread-1',
        queueJid: 'group@g.us::thread:thread-1',
        messageId: 'message:group:g:thread-1:1',
        messageCursor: '2024-01-01T00:00:01.000Z::1',
        senderUserId: 'user@s.whatsapp.net',
        senderDisplayName: 'User',
        idempotencyKey: 'provider:thread-msg-1',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:01.000Z',
        updatedAt: '2024-01-01T00:00:01.000Z',
        claimedAt: '2024-01-01T00:00:01.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(deps.sentTo).toHaveLength(0);
    expect(deps.enqueued).toHaveLength(0);
    expect(
      decodeGroupMessageCursor(deps.cursors['group@g.us::thread:thread-1']),
    ).toEqual({
      timestamp: '2024-01-01T00:00:01.000Z',
      id: '1',
    });
    expect(saveState).toHaveBeenCalledOnce();
  });

  it('allows untagged continuation inside a thread that already has a thread cursor', async () => {
    const message = {
      ...makePendingMessage(2),
      content: 'yes, continue with that',
      thread_id: 'thread-1',
      reply_to_message_id: 'thread-root',
    };
    const rootMessage = {
      ...makePendingMessage(1),
      content: '@Andy please help with this',
      thread_id: 'thread-1',
      message_id: 'thread-root',
    };
    mockGetMessagesSince
      .mockReturnValueOnce([message])
      .mockReturnValueOnce([rootMessage]);
    const deps = makeDeps({
      getOrRecoverCursor: (queueJid: string) =>
        queueJid.includes('::thread:')
          ? '2024-01-01T00:00:01.000Z::1'
          : 'root-cursor',
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: true,
        },
      }),
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-thread-2',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: 'thread-1',
        queueJid: 'group@g.us::thread:thread-1',
        messageId: 'message:group:g:thread-1:2',
        messageCursor: '2024-01-01T00:00:02.000Z::2',
        senderUserId: 'user@s.whatsapp.net',
        senderDisplayName: 'User',
        idempotencyKey: 'provider:thread-msg-2',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:02.000Z',
        updatedAt: '2024-01-01T00:00:02.000Z',
        claimedAt: '2024-01-01T00:00:02.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(deps.sentTo).toEqual(['group@g.us::thread:thread-1']);
  });

  it('ignores untagged messages in a cursor-bearing human thread without a trigger-owned root', async () => {
    const message = {
      ...makePendingMessage(2),
      content: '@Arhan can you check this when you get time',
      thread_id: 'thread-1',
      reply_to_message_id: 'human-root',
    };
    mockGetMessagesSince.mockReturnValueOnce([message]).mockReturnValueOnce([
      {
        ...makePendingMessage(1),
        content: 'human thread root',
        thread_id: 'thread-1',
        message_id: 'human-root',
      },
    ]);
    const saveState = vi.fn();
    const deps = makeDeps({
      saveState,
      getOrRecoverCursor: (queueJid: string) =>
        queueJid.includes('::thread:')
          ? '2024-01-01T00:00:01.000Z::1'
          : 'root-cursor',
      getConversationRoutes: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: true,
        },
      }),
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-thread-human',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: 'thread-1',
        queueJid: 'group@g.us::thread:thread-1',
        messageId: 'message:group:g:thread-1:2',
        messageCursor: '2024-01-01T00:00:02.000Z::2',
        senderUserId: 'user@s.whatsapp.net',
        senderDisplayName: 'User',
        idempotencyKey: 'provider:thread-msg-human',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:02.000Z',
        updatedAt: '2024-01-01T00:00:02.000Z',
        claimedAt: '2024-01-01T00:00:02.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('completed');

    expect(deps.sentTo).toHaveLength(0);
    expect(deps.enqueued).toHaveLength(0);
    expect(
      decodeGroupMessageCursor(deps.cursors['group@g.us::thread:thread-1']),
    ).toEqual({
      timestamp: '2024-01-01T00:00:02.000Z',
      id: '2',
    });
    expect(saveState).toHaveBeenCalledOnce();
  });

  it('defers durable live admission when the message queue rejects capacity', async () => {
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
    mockGetMessagesSince.mockReturnValueOnce([msg]);
    const deps = makeDeps({
      queue: {
        ...makeDeps().queue,
        sendMessage: () => false,
        enqueueMessageCheck: () => false,
      },
    });
    const { processLiveAdmissionWorkItem } =
      await import('@core/runtime/message-loop.js');

    await expect(
      processLiveAdmissionWorkItem(deps, {
        id: 'admission-1',
        appId: 'default',
        agentId: null,
        agentSessionId: null,
        conversationId: 'group@g.us',
        threadId: null,
        queueJid: 'group@g.us',
        messageId: 'message:group@g.us:1',
        messageCursor: '2024-01-01T00:00:01.000Z::1',
        senderUserId: 'user@s.whatsapp.net',
        senderDisplayName: 'User',
        idempotencyKey: 'provider:msg-1',
        state: 'claimed',
        sourceKind: 'message',
        triggerDecision: {},
        claimWorkerInstanceId: 'worker-1',
        claimToken: 'claim-1',
        claimExpiresAt: '2024-01-01T00:01:00.000Z',
        fencingVersion: 1,
        retryCount: 1,
        failureCount: 0,
        deferUntil: null,
        deferredReason: null,
        createdAt: '2024-01-01T00:00:01.000Z',
        updatedAt: '2024-01-01T00:00:01.000Z',
        claimedAt: '2024-01-01T00:00:01.000Z',
        endedAt: null,
      }),
    ).resolves.toBe('queued_capacity');
  });
});
