import { describe, expect, it, vi } from 'vitest';

import { ConversationMessageIngressModule } from '@core/application/external-ingress/conversation-message-ingress.js';

function makeModule(overrides?: {
  conversation?: Record<string, unknown> | null;
  thread?: Record<string, unknown> | null;
  routable?: boolean;
}) {
  const conversations = {
    getConversation: vi.fn(async () =>
      overrides?.conversation === null
        ? null
        : {
            id: 'conversation:tg:-100',
            appId: 'app-one',
            providerConnectionId: 'channel-providerConnection:app-one:telegram',
            externalRef: { kind: 'conversation', value: '-100' },
            kind: 'group',
            title: 'Team',
            status: 'active',
            createdAt: '2026-04-24T00:00:00.000Z',
            updatedAt: '2026-04-24T00:00:00.000Z',
            ...overrides?.conversation,
          },
    ),
    getThread: vi.fn(async () =>
      overrides?.thread === null
        ? null
        : {
            id: 'thread:tg:-100:42',
            appId: 'app-one',
            conversationId: 'conversation:tg:-100',
            externalRef: { kind: 'conversation_thread', value: '42' },
            title: 'Topic',
            status: 'active',
            createdAt: '2026-04-24T00:00:00.000Z',
            updatedAt: '2026-04-24T00:00:00.000Z',
            ...overrides?.thread,
          },
    ),
  };
  const ops = {
    storeChatMetadata: vi.fn(async () => undefined),
    storeMessage: vi.fn(async () => undefined),
  };
  const runtimeEvents = {
    publish: vi.fn(async () => ({ eventId: 77 })),
  };
  const module = new ConversationMessageIngressModule({
    conversations: conversations as never,
    ops,
    runtimeEvents,
    isConversationRoutable: vi.fn(() => overrides?.routable ?? true),
    providerForConversationJid: (jid) =>
      jid.startsWith('tg:') ? 'telegram' : 'app',
    makeQueueKey: (jid, threadId) =>
      threadId ? `${jid}::thread:${threadId}` : jid,
    now: () => '2026-04-24T00:00:00.000Z',
    createId: () => 'message-1',
  });
  return { module, conversations, ops, runtimeEvents };
}

describe('ConversationMessageIngressModule', () => {
  it('persists an inbound conversation message and queues the provider thread', async () => {
    const { module, ops, runtimeEvents } = makeModule();

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        message: 'Run this',
        senderId: 'external-system',
        senderName: 'External System',
      }),
    ).resolves.toEqual({
      messageId: 'message-1',
      conversationId: 'conversation:tg:-100',
      threadId: 'thread:tg:-100:42',
      acceptedEventId: 77,
      enqueue: {
        conversationJid: 'tg:-100',
        threadId: '42',
        queueKey: 'tg:-100::thread:42',
      },
    });
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'message-1',
        chat_jid: 'tg:-100',
        provider: 'telegram',
        sender: 'external-system',
        sender_name: 'External System',
        content: 'Run this',
        external_message_id: 'external-ingress:invocation-1',
        thread_id: '42',
      }),
    );
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        eventType: 'conversation.message.inbound',
        actor: 'external-system',
        responseMode: 'none',
        payload: expect.objectContaining({
          direction: 'inbound',
          deliveryStatus: 'accepted',
        }),
      }),
    );
  });

  it('rejects conversations outside the ingress app scope', async () => {
    const { module, ops } = makeModule({
      conversation: { appId: 'other-app' },
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:tg:-100',
        message: 'Run this',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Ingress cannot access this conversation',
    });
    expect(ops.storeMessage).not.toHaveBeenCalled();
  });

  it('rejects threads that do not belong to the conversation', async () => {
    const { module, ops } = makeModule({
      thread: { conversationId: 'conversation:tg:-200' },
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        message: 'Run this',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Conversation thread not found',
    });
    expect(ops.storeMessage).not.toHaveBeenCalled();
  });

  it('accepts canonical thread ids even when no thread row has been discovered yet', async () => {
    const { module, ops } = makeModule({
      thread: null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:2771',
        message: 'Run this',
      }),
    ).resolves.toMatchObject({
      threadId: 'thread:tg:-100:2771',
      enqueue: {
        conversationJid: 'tg:-100',
        threadId: '2771',
      },
    });
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: '2771',
      }),
    );
  });

  it('rejects conversations that are not active runtime routes', async () => {
    const { module, ops } = makeModule({ routable: false });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:tg:-100',
        message: 'Run this',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Conversation is not configured for runtime routing',
    });
    expect(ops.storeMessage).not.toHaveBeenCalled();
  });
});
