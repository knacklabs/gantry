import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { CanonicalMessageOpsService } from '@core/adapters/storage/postgres/services/canonical-message-ops-service.js';
import {
  externalRefForMessage,
  PostgresCanonicalMessageRepository,
  type CanonicalOpsMessageRow,
} from '@core/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';

function messageRow(
  overrides: Partial<CanonicalOpsMessageRow> = {},
): CanonicalOpsMessageRow {
  const id = overrides.id ?? 'message:tg:one:m-1';
  const providerId = id.split(':').at(-1) ?? 'm-1';
  return {
    id,
    conversation_id: 'conversation:tg:one',
    thread_id: null,
    external_ref_json: JSON.stringify({
      id: providerId,
      chat_jid: 'tg:one',
    }),
    direction: 'inbound',
    sender_user_id: '42',
    sender_display_name: 'Ravi',
    trust: 'trusted',
    created_at: '2026-05-06T00:00:00.000Z',
    received_at: '2026-05-06T00:00:00.000Z',
    delivery_status: null,
    delivered_at: null,
    delivery_error: null,
    payload_json: JSON.stringify({ kind: 'text', text: providerId }),
    attachments_json: null,
    ...overrides,
  };
}

function flattenSqlShape(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => flattenSqlShape(entry, seen)).join(' ');
  }
  const record = value as Record<string | symbol, unknown>;
  return [
    typeof record.value === 'string'
      ? record.value
      : flattenSqlShape(record.value, seen),
    typeof record.name === 'string' ? record.name : '',
    flattenSqlShape(record.queryChunks, seen),
    flattenSqlShape(record.config, seen),
  ].join(' ');
}

describe('CanonicalMessageOpsService', () => {
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

  it('passes route provider account scope to replay reads', async () => {
    const listInboundMessages = vi.fn().mockResolvedValue([]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    await service.getMessagesSince('sl:C123', '', 50, {
      threadId: '1710000001.000100',
      providerAccountId: 'slack_beta',
    });

    expect(listInboundMessages).toHaveBeenCalledWith({
      jids: ['sl:C123'],
      after: undefined,
      threadId: '1710000001.000100',
      providerAccountId: 'slack_beta',
      hasThreadFilter: true,
      limit: 50,
    });
  });

  it('keeps message content and attachments out of external refs while mapping stored attachments', async () => {
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
      responseSchema: { type: 'object', required: ['answer'] },
      agentControls: {
        effort: 'high',
        thinking: { mode: 'on', budgetTokens: 2048 },
        maxOutputTokens: 4096,
      },
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
      response_schema: { type: 'object', required: ['answer'] },
      effort: 'high',
      thinking: { mode: 'on', budgetTokens: 2048 },
      max_output_tokens: 4096,
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
        attachments_json: JSON.stringify([
          {
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 1234,
            externalId: 'file-ref',
            storageRef: 'artifact-ref',
            content: 'attachment body must not leak',
            providerPayload: { token: 'provider-secret' },
          },
        ]),
      },
    ]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    const result = await service.getMessagesSince('tg:one', '');

    expect(result).toMatchObject([
      {
        id: 'provider-message-1',
        chat_jid: 'tg:one',
        content: 'sensitive body',
        thread_id: 'thread-1',
        reply_to_message_content: undefined,
        responseSchema: { type: 'object', required: ['answer'] },
        agentControls: {
          effort: 'high',
          thinking: { mode: 'on', budgetTokens: 2048 },
          maxOutputTokens: 4096,
        },
        attachments: [
          {
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 1234,
            externalId: 'file-ref',
            storageRef: 'artifact-ref',
          },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(
      'attachment body must not leak',
    );
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });

  it('rejects invalid persisted thinking metadata during replay mapping', async () => {
    const invalidThinking = [
      { mode: 'off', budgetTokens: 1 },
      { mode: 'on', budgetTokens: 0 },
      { mode: 'on', budgetTokens: 1.5 },
    ];
    const listInboundMessages = vi.fn().mockResolvedValue(
      invalidThinking.map((thinking, index) =>
        messageRow({
          id: `message:tg:one:invalid-${index}`,
          external_ref_json: JSON.stringify({
            id: `invalid-${index}`,
            chat_jid: 'tg:one',
            thinking,
          }),
        }),
      ),
    );
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    const result = await service.getMessagesSince('tg:one', '');

    expect(result).toHaveLength(3);
    for (const message of result) {
      expect(message.agentControls).toBeUndefined();
    }
  });

  it('requests recent top-level messages before a cursor and returns them oldest-to-newest', async () => {
    const rows = [
      messageRow({
        id: 'message:tg:one:m-3',
        created_at: '2026-05-06T00:03:00.000Z',
      }),
      messageRow({
        id: 'message:tg:one:m-2',
        created_at: '2026-05-06T00:02:00.000Z',
      }),
    ];
    const listContextMessages = vi.fn().mockResolvedValue(rows);
    const service = new CanonicalMessageOpsService({
      listContextMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    const result = await service.getRecentTopLevelMessagesBefore(
      'tg:one',
      {
        id: 'm-4',
        timestamp: '2026-05-06T00:04:00.000Z',
      },
      2,
    );

    expect(listContextMessages).toHaveBeenCalledWith({
      jids: ['tg:one'],
      before: {
        chatJid: 'tg:one',
        id: 'm-4',
        timestamp: '2026-05-06T00:04:00.000Z',
      },
      threadId: null,
      hasThreadFilter: true,
      includeSelfThreadRoots: true,
      limit: 2,
      order: 'desc',
    });
    expect(result.map((message) => message.id)).toEqual(['m-2', 'm-3']);
  });

  it('includes outbound Gantry messages in top-level context windows while replay stays inbound-only', async () => {
    const inbound = messageRow({
      id: 'message:tg:one:user-followup',
      created_at: '2026-05-06T00:03:00.000Z',
      external_ref_json: JSON.stringify({
        id: 'user-followup',
        chat_jid: 'tg:one',
      }),
      payload_json: JSON.stringify({ kind: 'text', text: 'follow up' }),
    });
    const outbound = messageRow({
      id: 'message:tg:one:gantry-answer',
      direction: 'outbound',
      sender_user_id: 'gantry',
      sender_display_name: 'Gantry',
      trust: 'system',
      created_at: '2026-05-06T00:02:00.000Z',
      external_ref_json: JSON.stringify({
        id: 'gantry-answer',
        chat_jid: 'tg:one',
        is_from_me: true,
        is_bot_message: true,
      }),
      payload_json: JSON.stringify({ kind: 'text', text: 'prior answer' }),
      delivery_status: 'sent',
      delivered_at: '2026-05-06T00:02:01.000Z',
    });
    const listInboundMessages = vi.fn().mockResolvedValue([inbound]);
    const listContextMessages = vi.fn().mockResolvedValue([inbound, outbound]);
    const service = new CanonicalMessageOpsService({
      listInboundMessages,
      listContextMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    const replay = await service.getMessagesSince('tg:one', '', 10);
    const context = await service.getRecentTopLevelMessagesBefore(
      'tg:one',
      {
        id: 'current',
        timestamp: '2026-05-06T00:04:00.000Z',
      },
      10,
    );

    expect(replay.map((message) => message.id)).toEqual(['user-followup']);
    expect(context.map((message) => message.id)).toEqual([
      'gantry-answer',
      'user-followup',
    ]);
    expect(context[0]).toMatchObject({
      id: 'gantry-answer',
      content: 'prior answer',
      is_from_me: true,
      is_bot_message: true,
    });
  });

  it('filters context repository reads to inbound rows or sent outbound rows', async () => {
    let capturedWhere: unknown;
    const lateralLimit = vi.fn(() => ({
      as: vi.fn(() => ({ payloadJson: sql`first_part.payload_json` })),
    }));
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({ limit: lateralLimit })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            leftJoinLateral: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                capturedWhere = condition;
                return {
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(async () => []),
                  })),
                };
              }),
            })),
          })),
        }),
    };
    const repository = new PostgresCanonicalMessageRepository(db as never);

    await repository.listContextMessages({
      jids: ['tg:one'],
      limit: 10,
    });

    const whereShape = flattenSqlShape(capturedWhere);
    expect(whereShape).toContain('direction');
    expect(whereShape).toContain('inbound');
    expect(whereShape).toContain('outbound');
    expect(whereShape).toContain('delivery_status');
    expect(whereShape).toContain('sent');
    expect(whereShape).toContain('external_ref_json');
    expect(whereShape).toContain('::jsonb');
    expect(whereShape).toContain('chat_jid');
    expect(whereShape).not.toContain('pending');
    expect(whereShape).not.toContain('failed');
    expect(whereShape).not.toContain('partially_sent');
  });

  it('scopes repository reads to account conversations when provider account is known', async () => {
    let capturedWhere: unknown;
    const lateralLimit = vi.fn(() => ({
      as: vi.fn(() => ({ payloadJson: sql`first_part.payload_json` })),
    }));
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({ limit: lateralLimit })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            leftJoinLateral: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                capturedWhere = condition;
                return {
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(async () => []),
                  })),
                };
              }),
            })),
          })),
        }),
    };
    const repository = new PostgresCanonicalMessageRepository(db as never);

    await repository.listContextMessages({
      jids: ['sl:C123'],
      providerAccountId: 'slack_beta',
      threadId: '1710000001.000100',
      hasThreadFilter: true,
      limit: 10,
    });

    const whereShape = flattenSqlShape(capturedWhere);
    expect(whereShape).toContain('conversation:slack_beta:sl:C123');
    expect(whereShape).not.toContain('conversation:sl:C123');
    expect(whereShape).toContain('provider_account_id');
    expect(whereShape).toContain('thread:slack_beta:sl:C123:');
    expect(whereShape).toContain('external_ref_json');
    expect(whereShape).toContain('::jsonb');
    expect(whereShape).toContain('thread_id');
  });

  it('lists each canonical thread id once with one representative external ref', async () => {
    const groupBy = vi.fn(() => ({
      orderBy: vi.fn(async () => [
        {
          thread_id: 'thread:sl:C123:1710000001.000100',
          external_ref_json: JSON.stringify({
            chat_jid: 'sl:C123',
            thread_id: '1710000001.000100',
            external_message_id: '1710000001.000100',
          }),
        },
      ]),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ groupBy })),
        })),
      })),
      selectDistinct: vi.fn(),
    };
    const repository = new PostgresCanonicalMessageRepository(db as never);

    await expect(repository.listThreadIds('sl:C123')).resolves.toEqual([
      '1710000001.000100',
    ]);
    expect(db.selectDistinct).not.toHaveBeenCalled();
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('scopes pagination cursor message ids to the provider account', async () => {
    let capturedWhere: unknown;
    const lateralLimit = vi.fn(() => ({
      as: vi.fn(() => ({ payloadJson: sql`first_part.payload_json` })),
    }));
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({ limit: lateralLimit })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            leftJoinLateral: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                capturedWhere = condition;
                return {
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(async () => []),
                  })),
                };
              }),
            })),
          })),
        }),
    };
    const repository = new PostgresCanonicalMessageRepository(db as never);

    await repository.listContextMessages({
      jids: ['sl:C123'],
      providerAccountId: 'slack_beta',
      after: {
        chatJid: 'sl:C123',
        id: '1710000001.000100',
        timestamp: '2026-05-06T00:00:00.000Z',
      },
      before: {
        chatJid: 'sl:C123',
        id: '1710000002.000100',
        timestamp: '2026-05-06T00:01:00.000Z',
      },
      beforeOrAt: {
        chatJid: 'sl:C123',
        id: '1710000003.000100',
        timestamp: '2026-05-06T00:02:00.000Z',
      },
      limit: 10,
    });

    const whereShape = flattenSqlShape(capturedWhere);
    expect(whereShape).toContain(
      'message:slack_beta:sl:C123:1710000001.000100',
    );
    expect(whereShape).toContain(
      'message:slack_beta:sl:C123:1710000002.000100',
    );
    expect(whereShape).toContain(
      'message:slack_beta:sl:C123:1710000003.000100',
    );
  });

  it('includes Slack self-thread roots but excludes replies from recent top-level reads', async () => {
    const rows = [
      messageRow({
        id: 'message:sl:C123:1710000002.000200',
        conversation_id: 'conversation:sl:C123',
        thread_id: 'thread:sl:C123:1710000002.000200',
        created_at: '2026-05-06T00:02:00.000Z',
        external_ref_json: JSON.stringify({
          id: '1710000002.000200',
          chat_jid: 'sl:C123',
          provider: 'slack',
          thread_id: '1710000002.000200',
          external_message_id: '1710000002.000200',
        }),
        payload_json: JSON.stringify({
          kind: 'text',
          text: 'self-thread root',
        }),
      }),
      messageRow({
        id: 'message:sl:C123:1710000003.000300',
        conversation_id: 'conversation:sl:C123',
        thread_id: 'thread:sl:C123:1710000002.000200',
        created_at: '2026-05-06T00:03:00.000Z',
        external_ref_json: JSON.stringify({
          id: '1710000003.000300',
          chat_jid: 'sl:C123',
          provider: 'slack',
          thread_id: '1710000002.000200',
          external_message_id: '1710000003.000300',
        }),
        payload_json: JSON.stringify({
          kind: 'text',
          text: 'thread reply',
        }),
      }),
    ];
    const listContextMessages = vi.fn(async (input) =>
      rows.filter(
        (row) =>
          row.thread_id === null ||
          (input.includeSelfThreadRoots &&
            row.thread_id ===
              `thread:sl:C123:${JSON.parse(row.external_ref_json ?? '{}').external_message_id}`),
      ),
    );
    const service = new CanonicalMessageOpsService({
      listContextMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    const result = await service.getRecentTopLevelMessagesBefore(
      'sl:C123',
      {
        id: '1710000004.000400',
        timestamp: '2026-05-06T00:04:00.000Z',
      },
      10,
    );

    expect(listContextMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        jids: ['sl:C123'],
        threadId: null,
        hasThreadFilter: true,
        includeSelfThreadRoots: true,
      }),
    );
    expect(result.map((message) => message.id)).toEqual(['1710000002.000200']);
    expect(result.map((message) => message.content)).toEqual([
      'self-thread root',
    ]);
  });

  it('requests the first thread messages and round-trips public thread ids', async () => {
    const rows = [
      messageRow({
        id: 'message:tg:one:root',
        thread_id: 'thread:tg:one:thread-1',
        external_ref_json: JSON.stringify({
          id: 'root',
          chat_jid: 'tg:one',
        }),
      }),
      messageRow({
        id: 'message:tg:one:reply',
        thread_id: 'thread:tg:one:thread-1',
        external_ref_json: JSON.stringify({
          id: 'reply',
          chat_jid: 'tg:one',
          thread_id: 'thread-1',
        }),
      }),
    ];
    const listContextMessages = vi.fn().mockResolvedValue(rows);
    const service = new CanonicalMessageOpsService({
      listContextMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    const result = await service.getFirstThreadMessages(
      'tg:one',
      'thread-1',
      2,
    );

    expect(listContextMessages).toHaveBeenCalledWith({
      jids: ['tg:one'],
      threadId: 'thread-1',
      hasThreadFilter: true,
      limit: 2,
    });
    expect(result.map((message) => message.id)).toEqual(['root', 'reply']);
    expect(result.map((message) => message.thread_id)).toEqual([
      'thread-1',
      'thread-1',
    ]);
  });

  it('requests latest thread messages up to the trigger and returns them oldest-to-newest', async () => {
    const rows = [
      messageRow({
        id: 'message:tg:one:m-4',
        thread_id: 'thread:tg:one:thread-1',
        created_at: '2026-05-06T00:04:00.000Z',
        external_ref_json: JSON.stringify({
          id: 'm-4',
          chat_jid: 'tg:one',
          thread_id: 'thread-1',
        }),
      }),
      messageRow({
        id: 'message:tg:one:m-3',
        thread_id: 'thread:tg:one:thread-1',
        created_at: '2026-05-06T00:03:00.000Z',
        external_ref_json: JSON.stringify({
          id: 'm-3',
          chat_jid: 'tg:one',
          thread_id: 'thread-1',
        }),
      }),
    ];
    const listContextMessages = vi.fn().mockResolvedValue(rows);
    const service = new CanonicalMessageOpsService({
      listContextMessages,
    } as unknown as PostgresCanonicalMessageRepository);

    const result = await service.getLatestThreadMessages(
      'tg:one',
      'thread-1',
      {
        id: 'm-4',
        timestamp: '2026-05-06T00:04:00.000Z',
      },
      2,
    );

    expect(listContextMessages).toHaveBeenCalledWith({
      jids: ['tg:one'],
      beforeOrAt: {
        chatJid: 'tg:one',
        id: 'm-4',
        timestamp: '2026-05-06T00:04:00.000Z',
      },
      threadId: 'thread-1',
      hasThreadFilter: true,
      limit: 2,
      order: 'desc',
    });
    expect(result.map((message) => message.id)).toEqual(['m-3', 'm-4']);
  });

  it('preserves stored attachment rows when duplicate hydrated upserts omit attachments', async () => {
    const tx = {
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(async () => undefined),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, {
      graph: {
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000100',
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: 'duplicate hydrated message',
        timestamp: '2026-05-06T00:00:00.000Z',
      },
      {},
    );

    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it('clears stored attachment rows when duplicate hydrated upserts explicitly pass empty attachments', async () => {
    const deleteWhere = vi.fn(async () => undefined);
    const tx = {
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(async () => undefined),
        })),
      })),
      delete: vi.fn(() => ({
        where: deleteWhere,
      })),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, {
      graph: {
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000100',
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: 'duplicate hydrated message',
        timestamp: '2026-05-06T00:00:00.000Z',
        attachments: [],
      },
      {},
    );

    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
  });

  it('uses explicit provider account when saving inbound channel messages', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        }),
      })),
      delete: vi.fn(),
    };
    const graph = {
      ensureConversation: vi.fn(async () => 'conversation:slack_beta:sl:C123'),
      ensureThread: vi.fn(async () => 'thread:slack_beta:sl:C123:root'),
      getConversationInstallationId: vi.fn(async () => 'slack_alpha'),
      ensureParticipant: vi.fn(async () => undefined),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, { graph });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000100',
        chat_jid: 'sl:C123',
        provider: 'slack',
        providerAccountId: 'slack_beta',
        sender: 'U123',
        sender_name: 'Ravi',
        content: 'hello',
        timestamp: '2026-05-06T00:00:00.000Z',
        thread_id: 'root',
      },
      {},
    );

    expect(graph.ensureConversation).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ providerAccountId: 'slack_beta' }),
      tx,
    );
    expect(graph.ensureThread).toHaveBeenCalledWith(
      'sl:C123',
      'root',
      tx,
      expect.objectContaining({ providerAccountId: 'slack_beta' }),
    );
    expect(graph.getConversationInstallationId).not.toHaveBeenCalled();
    expect(insertedValues[0]).toMatchObject({
      id: 'message:slack_beta:sl:C123:1710000001.000100',
      providerAccountId: 'slack_beta',
      conversationId: 'conversation:slack_beta:sl:C123',
      threadId: 'thread:slack_beta:sl:C123:root',
    });
  });

  it.each([
    { name: 'top-level', threadId: undefined, storedThreadId: null },
    {
      name: 'threaded',
      threadId: 'root',
      storedThreadId: 'thread:slack_beta:sl:C123:root',
    },
  ])(
    'updates an existing provider-account $name message on redelivery',
    async ({ threadId, storedThreadId }) => {
      const insertedValues: unknown[] = [];
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                { id: 'message:slack_beta:sl:C123:provider-event-1' },
              ]),
            })),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((values: unknown) => {
            insertedValues.push(values);
            return { onConflictDoUpdate: vi.fn(async () => undefined) };
          }),
        })),
        delete: vi.fn(),
      };
      const repository = new PostgresCanonicalMessageRepository({} as never);
      Object.assign(repository, {
        graph: {
          ensureConversation: vi.fn(
            async () => 'conversation:slack_beta:sl:C123',
          ),
          ensureThread: vi.fn(async () => storedThreadId),
          getConversationInstallationId: vi.fn(async () => 'slack_beta'),
          ensureParticipant: vi.fn(async () => undefined),
        },
      });

      await repository.saveMessageWithExecutor(
        tx as never,
        {
          id: 'local-retry-id',
          chat_jid: 'sl:C123',
          provider: 'slack',
          providerAccountId: 'slack_beta',
          sender: 'U123',
          sender_name: 'Ravi',
          content: 'redelivered',
          timestamp: '2026-05-06T00:00:00.000Z',
          external_message_id: 'provider-event-1',
          ...(threadId ? { thread_id: threadId } : {}),
        },
        {},
      );

      expect(tx.select).toHaveBeenCalledTimes(1);
      expect(insertedValues[0]).toMatchObject({
        id: 'message:slack_beta:sl:C123:provider-event-1',
        providerAccountId: 'slack_beta',
        conversationId: 'conversation:slack_beta:sl:C123',
        threadId: storedThreadId,
        externalMessageId: 'provider-event-1',
      });
      expect(insertedValues[1]).toMatchObject({
        messageId: 'message:slack_beta:sl:C123:provider-event-1',
      });
    },
  );

  it('uses live admission provider account before ensuring conversation scope', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          if (
            values &&
            typeof values === 'object' &&
            String((values as Record<string, unknown>).id).startsWith(
              'live-admission:',
            )
          ) {
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(async () => [values]),
              })),
            };
          }
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        }),
      })),
      delete: vi.fn(),
    };
    const graph = {
      ensureConversation: vi.fn(async () => 'conversation:slack_beta:sl:C123'),
      ensureThread: vi.fn(async () => 'thread:slack_beta:sl:C123:root'),
      getConversationInstallationId: vi.fn(async () => 'slack_alpha'),
      ensureParticipant: vi.fn(async () => undefined),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, { graph });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000100',
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: 'hello',
        timestamp: '2026-05-06T00:00:00.000Z',
        thread_id: 'root',
      },
      {
        liveAdmission: {
          appId: 'app-one',
          agentId: 'alpha',
          providerAccountId: 'slack_beta',
        },
      },
    );

    expect(graph.ensureConversation).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({ providerAccountId: 'slack_beta' }),
      tx,
    );
    expect(graph.ensureThread).toHaveBeenCalledWith(
      'sl:C123',
      'root',
      tx,
      expect.objectContaining({ providerAccountId: 'slack_beta' }),
    );
    expect(graph.getConversationInstallationId).not.toHaveBeenCalled();
    expect(insertedValues[0]).toMatchObject({
      id: 'message:slack_beta:sl:C123:1710000001.000100',
      providerAccountId: 'slack_beta',
    });
  });

  it('agent-qualifies live admission work item identity and queue jid', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          if (
            values &&
            typeof values === 'object' &&
            String((values as Record<string, unknown>).id).startsWith(
              'live-admission:',
            )
          ) {
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(async () => [values]),
              })),
            };
          }
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        }),
      })),
      delete: vi.fn(),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, {
      graph: {
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => 'thread:sl:C123:thread-1'),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000100',
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: '@Alpha hello',
        timestamp: '2026-05-06T00:00:00.000Z',
        thread_id: 'thread-1',
      },
      { liveAdmission: { appId: 'app-one', agentId: 'alpha' } },
    );

    const admissionRow = insertedValues.find(
      (value): value is Record<string, unknown> =>
        !!value &&
        typeof value === 'object' &&
        String((value as Record<string, unknown>).id).startsWith(
          'live-admission:',
        ),
    );

    expect(admissionRow).toMatchObject({
      id: 'live-admission:app-one:agent:alpha:channel-providerAccount:default:slack:message:channel-providerAccount:default:slack:sl:C123:1710000001.000100',
      agentId: 'agent:alpha',
      queueJid:
        'sl:C123::thread:thread-1::agent:agent%3Aalpha::provider_account:channel-providerAccount%3Adefault%3Aslack',
      idempotencyKey:
        'live-admission:app-one:agent:alpha:channel-providerAccount:default:slack:sl:C123:thread-1:1710000001.000100',
    });
  });

  it('preserves stored attachment refs when replacing hydrated attachment rows', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              id: 'provider-attachment-id',
              externalRefJson: {
                kind: 'message_attachment',
                value: 'old-provider-external',
              },
              storageRef: 'artifact-by-id',
            },
            {
              id: 'old-generated-id',
              externalRefJson: {
                kind: 'message_attachment',
                value: 'provider-file-2',
              },
              storageRef: 'artifact-by-external-id',
            },
            {
              id: 'explicit-fresh-id',
              externalRefJson: {
                kind: 'message_attachment',
                value: 'provider-file-3',
              },
              storageRef: 'stale-artifact',
            },
          ]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, {
      graph: {
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000100',
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: 'duplicate hydrated message',
        timestamp: '2026-05-06T00:00:00.000Z',
        attachments: [
          {
            id: 'provider-attachment-id',
            kind: 'file',
            externalId: 'new-provider-external',
          },
          {
            id: 'new-generated-id',
            kind: 'file',
            externalId: 'provider-file-2',
          },
          {
            id: 'explicit-fresh-id',
            kind: 'file',
            externalId: 'provider-file-3',
            storageRef: 'fresh-artifact',
          },
          {
            id: 'new-unmatched-id',
            kind: 'file',
            externalId: 'provider-file-4',
          },
        ],
      },
      {},
    );

    expect(tx.select.mock.invocationCallOrder[0]).toBeLessThan(
      tx.delete.mock.invocationCallOrder[0],
    );
    const attachmentRows = insertedValues.find(
      (values): values is Array<Record<string, unknown>> =>
        Array.isArray(values) &&
        values.some(
          (value) =>
            !!value &&
            typeof value === 'object' &&
            (value as Record<string, unknown>).id === 'provider-attachment-id',
        ),
    );

    expect(attachmentRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider-attachment-id',
          storageRef: 'artifact-by-id',
        }),
        expect.objectContaining({
          id: 'new-generated-id',
          storageRef: 'artifact-by-external-id',
        }),
        expect.objectContaining({
          id: 'explicit-fresh-id',
          storageRef: 'fresh-artifact',
        }),
        expect.objectContaining({
          id: 'new-unmatched-id',
          storageRef: null,
        }),
      ]),
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
