import { describe, expect, it, vi } from 'vitest';

import { ConversationMessageIngressModule } from '@core/application/external-ingress/conversation-message-ingress.js';

function makeModule(overrides?: {
  conversation?: Record<string, unknown> | null;
  thread?: Record<string, unknown> | null;
  ops?: Record<string, unknown>;
  runtimeEvents?: Record<string, unknown>;
  messageReactions?: Record<string, unknown>;
  routable?:
    | boolean
    | ((
        conversationJid: string,
        threadId?: string | null,
        providerAccountId?: string | null,
      ) => boolean);
  liveAdmissionAppId?: string | null;
  resolveRoute?: (input: {
    conversationJid: string;
    threadId: string | null;
    agentId?: string | null;
    providerAccountId?: string | null;
  }) => { agentId?: string | null; queueKey: string } | null;
  resolveProviderJidPrefix?: (
    providerAccountId: string,
  ) => Promise<string | null>;
  createId?: () => string;
}) {
  const conversations = {
    getConversation: vi.fn(async () =>
      overrides?.conversation === null
        ? null
        : {
            id: 'conversation:tg:-100',
            appId: 'app-one',
            providerAccountId: 'channel-providerAccount:app-one:telegram',
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
    ...overrides?.ops,
  };
  const runtimeEvents = {
    publish: vi.fn(async () => ({ eventId: 77 })),
    ...overrides?.runtimeEvents,
  };
  const module = new ConversationMessageIngressModule({
    conversations: conversations as never,
    ops: ops as never,
    runtimeEvents,
    messageReactions: overrides?.messageReactions as never,
    liveAdmissionAppId: overrides?.liveAdmissionAppId,
    isConversationRoutable: vi.fn(
      (conversationJid, threadId, providerAccountId) =>
        typeof overrides?.routable === 'function'
          ? overrides.routable(conversationJid, threadId, providerAccountId)
          : (overrides?.routable ?? true),
    ),
    providerForConversationJid: (jid) =>
      jid.startsWith('tg:')
        ? 'telegram'
        : jid.startsWith('sl:')
          ? 'slack'
          : 'app',
    resolveProviderJidPrefix: overrides?.resolveProviderJidPrefix,
    makeQueueKey: (jid, threadId) =>
      threadId ? `${jid}::thread:${threadId}` : jid,
    resolveRoute: overrides?.resolveRoute,
    now: () => '2026-04-24T00:00:00.000Z',
    createId: overrides?.createId ?? (() => 'message-1'),
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
        providerAccountId: 'channel-providerAccount:app-one:telegram',
        queueKey: 'tg:-100::thread:42',
        durableAdmissionCreated: false,
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

  it('returns not found and does not persist when no route resolves', async () => {
    const { module, ops } = makeModule({
      resolveRoute: () => null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:tg:-100',
        message: 'Run this',
        senderId: 'external-system',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Conversation is not configured for runtime routing',
    });
    expect(ops.storeChatMetadata).not.toHaveBeenCalled();
    expect(ops.storeMessage).not.toHaveBeenCalled();
  });

  it('checks routability after resolving the provider thread id', async () => {
    const { module, ops } = makeModule({
      routable: (_conversationJid, threadId, providerAccountId) =>
        threadId === '42' &&
        providerAccountId === 'channel-providerAccount:app-one:telegram',
      resolveRoute: (input) =>
        input.threadId === '42'
          ? { agentId: 'agent:main', queueKey: 'tg:-100::thread:42' }
          : null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:tg:-100',
        threadId: 'thread:tg:-100:42',
        message: 'Run this',
      }),
    ).resolves.toMatchObject({
      enqueue: {
        conversationJid: 'tg:-100',
        threadId: '42',
        queueKey: 'tg:-100::thread:42',
      },
    });
    expect(ops.storeMessage).toHaveBeenCalled();
  });

  it('routes account-scoped canonical conversation ids by provider jid', async () => {
    const { module, ops } = makeModule({
      conversation: {
        id: 'conversation:slack_default:sl:C123',
        providerAccountId: 'slack_default',
        externalRef: { kind: 'conversation', value: 'C123' },
      },
      thread: null,
      routable: (conversationJid, threadId, providerAccountId) =>
        conversationJid === 'sl:C123' &&
        threadId === null &&
        providerAccountId === 'slack_default',
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:slack_default:sl:C123',
        message: 'Run this',
      }),
    ).resolves.toMatchObject({
      enqueue: {
        conversationJid: 'sl:C123',
        providerAccountId: 'slack_default',
      },
    });
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'sl:C123',
        provider: 'slack',
      }),
    );
  });

  it('rebuilds provider jid for discovered unprefixed external conversation ids', async () => {
    const { module, ops } = makeModule({
      conversation: {
        id: 'conversation:slack_acct:C123',
        providerAccountId: 'slack_acct',
        externalRef: { kind: 'conversation', value: 'C123' },
      },
      thread: null,
      resolveProviderJidPrefix: async (providerAccountId) =>
        providerAccountId === 'slack_acct' ? 'sl:' : null,
      routable: (conversationJid, threadId, providerAccountId) =>
        conversationJid === 'sl:C123' &&
        threadId === null &&
        providerAccountId === 'slack_acct',
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:slack_acct:C123',
        message: 'Run this',
      }),
    ).resolves.toMatchObject({
      enqueue: {
        conversationJid: 'sl:C123',
        providerAccountId: 'slack_acct',
      },
    });
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'sl:C123',
        provider: 'slack',
      }),
    );
  });

  it('adds a seen reaction when ingress provides a native message ref', async () => {
    const addReaction = vi.fn(async () => undefined);
    const { module, ops } = makeModule({
      messageReactions: { addReaction },
    });

    await module.acceptMessage({
      appId: 'app-one',
      invocationId: 'invocation-1',
      conversationId: 'conversation:tg:-100',
      message: 'Run this',
      messageRef: '12345',
    });

    expect(addReaction).toHaveBeenCalledWith('tg:-100', '12345', 'seen', {
      providerAccountId: 'channel-providerAccount:app-one:telegram',
    });
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^external-ingress:/),
        external_message_id: '12345',
      }),
    );
  });

  it('uses a stable internal id for native message ref redelivery', async () => {
    let nextId = 0;
    const { module, ops } = makeModule({
      createId: () => `message-${(nextId += 1)}`,
    });

    const first = await module.acceptMessage({
      appId: 'app-one',
      invocationId: 'invocation-1',
      conversationId: 'conversation:tg:-100',
      message: 'Run this',
      messageRef: '12345',
    });
    const second = await module.acceptMessage({
      appId: 'app-one',
      invocationId: 'invocation-2',
      conversationId: 'conversation:tg:-100',
      message: 'Run this',
      messageRef: '12345',
    });

    expect(first.messageId).toBe(second.messageId);
    expect(ops.storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: first.messageId,
        external_message_id: '12345',
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

  it('accepts provider-scoped canonical thread ids before discovery', async () => {
    const { module, ops } = makeModule({
      conversation: {
        id: 'conversation:telegram_default:tg:-100',
        providerAccountId: 'telegram_default',
        externalRef: { kind: 'conversation', value: 'tg:-100' },
      },
      thread: null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        invocationId: 'invocation-1',
        conversationId: 'conversation:telegram_default:tg:-100',
        threadId: 'thread:telegram_default:tg:-100:2771',
        message: 'Run this',
      }),
    ).resolves.toMatchObject({
      threadId: 'thread:telegram_default:tg:-100:2771',
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

  it('writes live-admission work under the runtime app id when configured', async () => {
    const order: string[] = [];
    const publish = vi.fn();
    const publishWithLiveAdmissionMessage = vi.fn(async (_event, admission) => {
      order.push('publishAcceptedEventAndStoreAdmission');
      expect(admission).toMatchObject({
        message: {
          chat_jid: 'tg:-100',
          content: 'Run this',
        },
        liveAdmission: {
          appId: 'default',
          triggerDecision: {
            source: 'external_ingress',
            conversationKind: 'group',
          },
        },
      });
      return {
        event: { eventId: 77 },
        liveAdmissionResult: {
          outcome: 'enqueued',
          item: {
            id: 'admission-conversation-1',
            state: 'queued',
          },
        },
      };
    });
    const { module, ops } = makeModule({
      liveAdmissionAppId: 'default',
      ops: {
        notifyLiveAdmissionWorkItem: vi.fn(async () => {
          order.push('notifyLiveAdmissionWorkItem');
        }),
      },
      runtimeEvents: {
        publish,
        publishWithLiveAdmissionMessage,
      },
    });

    const accepted = await module.acceptMessage({
      appId: 'app-one',
      invocationId: 'invocation-1',
      conversationId: 'conversation:tg:-100',
      message: 'Run this',
    });

    expect(ops.storeMessage).not.toHaveBeenCalled();
    expect(order).toEqual([
      'publishAcceptedEventAndStoreAdmission',
      'notifyLiveAdmissionWorkItem',
    ]);
    expect(publish).not.toHaveBeenCalled();
    expect(accepted.enqueue.durableAdmissionCreated).toBe(true);
  });

  it('uses the resolved agent route for live admission and enqueue', async () => {
    const publishWithLiveAdmissionMessage = vi.fn(async (_event, admission) => {
      expect(admission).toMatchObject({
        message: {
          providerAccountId: 'channel-providerAccount:app-one:telegram',
        },
        liveAdmission: {
          appId: 'default',
          agentId: 'agent:main_agent',
          providerAccountId: 'channel-providerAccount:app-one:telegram',
        },
      });
      return {
        event: { eventId: 77 },
        liveAdmissionResult: {
          outcome: 'enqueued',
          item: {
            id: 'admission-conversation-1',
            state: 'queued',
          },
        },
      };
    });
    const resolveRoute = vi.fn(() => ({
      agentId: 'agent:main_agent',
      queueKey: 'tg:-100::thread:42::agent:agent%3Amain_agent',
    }));
    const { module } = makeModule({
      liveAdmissionAppId: 'default',
      resolveRoute,
      runtimeEvents: {
        publishWithLiveAdmissionMessage,
      },
    });

    const accepted = await module.acceptMessage({
      appId: 'app-one',
      invocationId: 'invocation-1',
      conversationId: 'conversation:tg:-100',
      threadId: 'thread:tg:-100:42',
      message: 'Run this',
    });

    expect(resolveRoute).toHaveBeenCalledWith({
      conversationJid: 'tg:-100',
      threadId: '42',
      agentId: null,
      providerAccountId: 'channel-providerAccount:app-one:telegram',
    });
    expect(accepted.enqueue.queueKey).toBe(
      'tg:-100::thread:42::agent:agent%3Amain_agent',
    );
    expect(accepted.enqueue.providerAccountId).toBe(
      'channel-providerAccount:app-one:telegram',
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
