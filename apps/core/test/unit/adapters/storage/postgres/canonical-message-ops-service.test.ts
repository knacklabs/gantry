import { describe, expect, it, vi } from 'vitest';

import { CanonicalMessageOpsService } from '@core/adapters/storage/postgres/services/canonical-message-ops-service.js';
import {
  externalRefForMessage,
  type PostgresCanonicalMessageRepository,
} from '@core/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';

describe('CanonicalMessageOpsService', () => {
  it('does not pass an after boundary for an empty global cursor', async () => {
    const listInboundMessages = vi.fn().mockResolvedValue([]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    await service.getNewMessages(['tg:one'], '');

    expect(listInboundMessages).toHaveBeenCalledWith({
      jids: ['tg:one'],
      after: undefined,
      limit: 200,
    });
  });

  it('does not pass an after boundary for an empty group cursor', async () => {
    const listInboundMessages = vi.fn().mockResolvedValue([]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    await service.getMessagesSince('tg:one', '', 50, { threadId: null });

    expect(listInboundMessages).toHaveBeenCalledWith({
      jids: ['tg:one'],
      after: undefined,
      threadId: null,
      hasThreadFilter: true,
      limit: 50,
    });
  });

  it('keeps message content out of external refs and reads content from parts', async () => {
    const ref = externalRefForMessage({
      id: 'provider-message-1',
      chat_jid: 'tg:one',
      provider: 'telegram',
      sender: '42',
      sender_name: 'Ravi',
      content: 'sensitive body',
      timestamp: '2026-05-06T00:00:00.000Z',
      thread_id: 'thread-1',
      reply_to_message_content: 'quoted sensitive body',
      external_message_id: 'provider-event-1',
      attachments: [
        {
          id: 'attachment-1',
          kind: 'file',
          externalId: 'file-ref',
          storageRef: 'artifact-ref',
        },
      ],
    });

    expect(ref).toMatchObject({
      id: 'provider-message-1',
      chat_jid: 'tg:one',
      provider: 'telegram',
      thread_id: 'thread-1',
      external_message_id: 'provider-event-1',
    });
    expect(ref).not.toHaveProperty('content');
    expect(ref).not.toHaveProperty('reply_to_message_content');
    expect(ref).not.toHaveProperty('attachments');

    const listInboundMessages = vi.fn().mockResolvedValue([
      {
        id: 'message:tg:one:provider-message-1',
        conversation_id: 'conversation:tg:one',
        thread_id: 'thread:tg:one:thread-1',
        external_ref_json: JSON.stringify(ref),
        direction: 'inbound',
        sender_user_id: '42',
        sender_display_name: 'Ravi',
        trust: 'trusted',
        created_at: '2026-05-06T00:00:00.000Z',
        received_at: '2026-05-06T00:00:00.000Z',
        delivery_status: null,
        delivered_at: null,
        delivery_error: null,
        payload_json: JSON.stringify({ kind: 'text', text: 'sensitive body' }),
      },
    ]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    await expect(service.getMessagesSince('tg:one', '')).resolves.toMatchObject(
      [
        {
          id: 'provider-message-1',
          chat_jid: 'tg:one',
          content: 'sensitive body',
          thread_id: 'thread-1',
          reply_to_message_content: undefined,
        },
      ],
    );
  });

  it('publishes an opaque live admission wakeup after storing a work item', async () => {
    const notifyLiveAdmissionWorkItem = vi.fn(async () => {});
    const saveMessage = vi.fn(async () => ({
      outcome: 'enqueued' as const,
      item: {
        id: 'live-admission:default:message-1',
        appId: 'default',
      },
    }));
    const service = new CanonicalMessageOpsService(
      { saveMessage } as unknown as PostgresCanonicalMessageRepository,
      { notifyLiveAdmissionWorkItem },
    );

    await service.storeMessageWithLiveAdmission(
      {
        id: 'provider-message-1',
        chat_jid: 'tg:one',
        provider: 'telegram',
        sender: '42',
        sender_name: 'Ravi',
        content: 'sensitive body',
        timestamp: '2026-05-06T00:00:00.000Z',
      },
      {
        appId: 'default',
        agentId: 'main',
      },
    );

    expect(notifyLiveAdmissionWorkItem).toHaveBeenCalledWith({
      appId: 'default',
      workItemId: 'live-admission:default:message-1',
    });
    expect(
      JSON.stringify(notifyLiveAdmissionWorkItem.mock.calls),
    ).not.toContain('sensitive body');
  });
});
