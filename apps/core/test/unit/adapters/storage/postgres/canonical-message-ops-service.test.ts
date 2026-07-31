import {
  access,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { CanonicalMessageOpsService } from '@core/adapters/storage/postgres/services/canonical-message-ops-service.js';
import {
  externalRefForMessage,
  PostgresCanonicalMessageRepository,
  type CanonicalOpsMessageRow,
} from '@core/adapters/storage/postgres/repositories/canonical-message-repository.postgres.js';
import { logger } from '@core/infrastructure/logging/logger.js';

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

function liveAdmissionSelectMock() {
  return vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => []),
        then: (resolve: (rows: Array<{ count: number }>) => void) =>
          resolve([{ count: 0 }]),
      })),
    })),
  }));
}

function messageUpsertResult(inserted = false) {
  return {
    returning: vi.fn(async () => [{ inserted }]),
  };
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
            id: 'attachment-row-1',
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 1234,
            externalId: 'file-ref',
            storageRef: 'artifact-ref',
            file_name: 'report.pdf',
            provider_fetch: {
              provider: 'slack',
              kind: 'file_id',
              id: 'F123',
              team_id: 'T123',
            },
            deleted_at: '2026-05-06T00:00:01.000+00:00',
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
            id: 'attachment-row-1',
            kind: 'file',
            contentType: 'application/pdf',
            sizeBytes: 1234,
            externalId: 'file-ref',
            storageRef: 'artifact-ref',
            file_name: 'report.pdf',
            provider_fetch: {
              provider: 'slack',
              kind: 'file_id',
              id: 'F123',
              team_id: 'T123',
            },
            deleted_at: '2026-05-06T00:00:01.000Z',
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
          onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, {
      graph: {
        findConversationIdForJid: vi.fn(async () => undefined),
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

  it('locks before clearing stored attachment rows when duplicate hydrated upserts explicitly pass empty attachments', async () => {
    const deletedAttachmentRows = [
      {
        id: 'removed-provider-attachment',
        externalRefJson: null,
        storageRef: 'provider-attachments/removed.txt',
        fileName: 'removed.txt',
        contentType: 'text/plain',
        sizeBytes: 7,
        providerFetchJson: null,
        deletedAt: null,
      },
    ];
    const deleteReturning = vi.fn(async () => deletedAttachmentRows);
    const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
    const cleanupMaterialization = vi.fn(async (_storageRef: string) => {});
    const cleanupTx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (run: (transaction: typeof cleanupTx) => Promise<unknown>) =>
          run(cleanupTx),
      ),
    };
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
        })),
      })),
      delete: vi.fn(() => ({
        where: deleteWhere,
      })),
    };
    const repository = new PostgresCanonicalMessageRepository(
      db as never,
      100,
      cleanupMaterialization,
    );
    Object.assign(repository, {
      graph: {
        findConversationIdForJid: vi.fn(async () => undefined),
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });

    const result = await repository.saveMessageWithExecutor(
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
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(cleanupMaterialization).not.toHaveBeenCalled();

    await repository.cleanupRemovedProviderAttachments(
      result.removedProviderStorageRefs,
    );

    expect(cleanupMaterialization).toHaveBeenCalledWith(
      'provider-attachments/removed.txt',
    );
  });

  it('adds no attachment lock, lookup, or cleanup statements for an ordinary empty first delivery', async () => {
    const cleanupMaterialization = vi.fn(async (_storageRef: string) => {});
    const db = {
      transaction: vi.fn(),
    };
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() =>
            messageUpsertResult(table === pgSchema.messagesPostgres),
          ),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository(
      db as never,
      100,
      cleanupMaterialization,
    );
    Object.assign(repository, {
      graph: {
        findConversationIdForJid: vi.fn(async () => undefined),
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });

    const result = await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000101',
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: 'ordinary first delivery',
        timestamp: '2026-05-06T00:00:00.000Z',
        attachments: [],
      },
      {},
    );

    expect(result.removedProviderStorageRefs).toEqual([]);
    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();

    await repository.cleanupRemovedProviderAttachments(
      result.removedProviderStorageRefs,
    );

    expect(db.transaction).not.toHaveBeenCalled();
    expect(cleanupMaterialization).not.toHaveBeenCalled();
  });

  it('routes the loser of concurrent same-message first deliveries through the locked update path', async () => {
    const messageUpsertOutcomes = [true, false];
    const deleteReturning = vi.fn(async () => []);
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() =>
            messageUpsertResult(
              table === pgSchema.messagesPostgres
                ? messageUpsertOutcomes.shift() === true
                : false,
            ),
          ),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({ returning: deleteReturning })),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, {
      graph: {
        findConversationIdForJid: vi.fn(async () => undefined),
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });
    const message = {
      id: '1710000001.000102',
      chat_jid: 'sl:C123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'Ravi',
      content: 'concurrent first delivery',
      timestamp: '2026-05-06T00:00:00.000Z',
      attachments: [],
    } as const;

    await repository.saveMessageWithExecutor(tx as never, message, {});

    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();

    // PostgreSQL serializes conflicting upserts on the message row. The
    // concurrent loser resumes as UPDATE, represented by this second save.
    await repository.saveMessageWithExecutor(tx as never, message, {});

    expect(messageUpsertOutcomes).toEqual([]);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(deleteReturning).toHaveBeenCalledTimes(1);
  });

  it('skips unlink when a stale save restores the ref before cleanup revalidation', async () => {
    const operations: string[] = ['save:commit'];
    const cleanupMaterialization = vi.fn(async () => {
      operations.push('unlink');
    });
    const cleanupTx = {
      execute: vi.fn(async () => {
        operations.push('lock');
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              operations.push('recheck:referenced');
              return [{ id: 'restored-attachment' }];
            }),
          })),
        })),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (run: (transaction: typeof cleanupTx) => Promise<unknown>) => {
          operations.push('cleanup:begin');
          const result = await run(cleanupTx);
          operations.push('cleanup:commit');
          return result;
        },
      ),
    };
    const repository = new PostgresCanonicalMessageRepository(
      db as never,
      100,
      cleanupMaterialization,
    );

    await repository.cleanupRemovedProviderAttachments([
      {
        messageId: 'canonical:message:sl:C123:1710000001.000100',
        storageRef: 'provider-attachments/restored.txt',
      },
    ]);

    expect(operations).toEqual([
      'save:commit',
      'cleanup:begin',
      'lock',
      'lock',
      'recheck:referenced',
      'cleanup:commit',
    ]);
    expect(cleanupMaterialization).not.toHaveBeenCalled();
  });

  it('keeps a dropped materialization and its row when the caller-owned transaction rolls back', async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), 'gantry-provider-cleanup-rollback-'),
    );
    const materializedPath = path.join(tempDir, 'only-copy.txt');
    await writeFile(materializedPath, 'durable bytes');
    const originalRow = {
      id: 'attachment-only-copy',
      externalRefJson: null,
      storageRef: 'provider-attachments/only-copy.txt',
      fileName: 'only-copy.txt',
      contentType: 'text/plain',
      sizeBytes: 13,
      providerFetchJson: null,
      deletedAt: null,
    };
    let storedRow: typeof originalRow | null = originalRow;
    const cleanupMaterialization = vi.fn(async () => {
      await unlink(materializedPath);
    });
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => (storedRow ? [storedRow] : [])),
        })),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: unknown) => {
          if (
            table === pgSchema.messageAttachmentsPostgres &&
            Array.isArray(values)
          ) {
            storedRow = (values[0] as typeof originalRow | undefined) ?? null;
          }
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const deletedRows =
            table === pgSchema.messageAttachmentsPostgres && storedRow
              ? [storedRow]
              : [];
          if (table === pgSchema.messageAttachmentsPostgres) {
            storedRow = null;
          }
          return {
            returning: vi.fn(async () => deletedRows),
          };
        }),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository(
      {} as never,
      100,
      cleanupMaterialization,
    );
    Object.assign(repository, {
      graph: {
        findConversationIdForJid: vi.fn(async () => undefined),
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });
    const callerOwnedDb = {
      transaction: async (fn: (executor: typeof tx) => Promise<void>) => {
        const rowBeforeTransaction = storedRow;
        try {
          await fn(tx);
        } catch (error) {
          storedRow = rowBeforeTransaction;
          throw error;
        }
      },
    };

    try {
      await expect(
        callerOwnedDb.transaction(async (executor) => {
          await repository.saveMessageWithExecutor(
            executor as never,
            {
              id: '1710000001.000100',
              chat_jid: 'sl:C123',
              provider: 'slack',
              sender: 'U123',
              sender_name: 'Ravi',
              content: 'replacement drops the only copy',
              timestamp: '2026-05-06T00:00:00.000Z',
              attachments: [],
            },
            {},
          );
          throw new Error('later transaction failure');
        }),
      ).rejects.toThrow('later transaction failure');

      expect(cleanupMaterialization).not.toHaveBeenCalled();
      await expect(access(materializedPath)).resolves.toBeUndefined();
      await expect(readFile(materializedPath, 'utf8')).resolves.toBe(
        'durable bytes',
      );
      expect(storedRow).toEqual(originalRow);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reclaims only dropped provider materializations after attachment replacement', async () => {
    const cleanupMaterialization = vi.fn(async (storageRef: string) => {
      if (storageRef.endsWith('cleanup-fails.txt')) {
        throw Object.assign(new Error('unlink failed'), { code: 'EACCES' });
      }
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertedValues: unknown[] = [];
    const cleanupTx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (run: (transaction: typeof cleanupTx) => Promise<unknown>) =>
          run(cleanupTx),
      ),
    };
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              id: 'dropped-provider',
              externalRefJson: null,
              storageRef: 'provider-attachments/dropped.txt',
              fileName: 'dropped.txt',
              contentType: 'text/plain',
              sizeBytes: 12,
              providerFetchJson: {
                provider: 'slack',
                kind: 'file_id',
                id: 'F-DROPPED',
              },
              deletedAt: null,
            },
            {
              id: 'preserved-provider',
              externalRefJson: null,
              storageRef: 'provider-attachments/preserved.txt',
              fileName: 'preserved.txt',
              contentType: 'text/plain',
              sizeBytes: 13,
              providerFetchJson: {
                provider: 'slack',
                kind: 'file_id',
                id: 'F-PRESERVED',
              },
              deletedAt: null,
            },
            {
              id: 'failed-provider-cleanup',
              externalRefJson: null,
              storageRef: 'provider-attachments/cleanup-fails.txt',
              fileName: 'cleanup-fails.txt',
              contentType: 'text/plain',
              sizeBytes: 15,
              providerFetchJson: null,
              deletedAt: null,
            },
            {
              id: 'dropped-workspace',
              externalRefJson: null,
              storageRef: 'attachments/workspace-live.txt',
              fileName: 'workspace-live.txt',
              contentType: 'text/plain',
              sizeBytes: 14,
              providerFetchJson: null,
              deletedAt: null,
            },
          ]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository(
      db as never,
      100,
      cleanupMaterialization,
    );
    Object.assign(repository, {
      graph: {
        findConversationIdForJid: vi.fn(async () => undefined),
        ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
        ensureThread: vi.fn(async () => null),
        getConversationInstallationId: vi.fn(async () => null),
        ensureParticipant: vi.fn(async () => undefined),
      },
    });

    const result = await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000001.000100',
        chat_jid: 'sl:C123',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: 'hydrated replacement',
        timestamp: '2026-05-06T00:00:00.000Z',
        attachments: [
          {
            kind: 'file',
            provider_fetch: {
              provider: 'slack',
              kind: 'file_id',
              id: 'F-PRESERVED',
            },
          },
        ],
      },
      {},
    );

    expect(insertedValues).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'preserved-provider',
          storageRef: 'provider-attachments/preserved.txt',
        }),
      ]),
    );
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(cleanupMaterialization).not.toHaveBeenCalled();

    await repository.cleanupRemovedProviderAttachments(
      result.removedProviderStorageRefs,
    );

    expect(cleanupMaterialization).toHaveBeenCalledTimes(2);
    expect(cleanupMaterialization).toHaveBeenCalledWith(
      'provider-attachments/dropped.txt',
    );
    expect(cleanupMaterialization).toHaveBeenCalledWith(
      'provider-attachments/cleanup-fails.txt',
    );
    expect(cleanupMaterialization).not.toHaveBeenCalledWith(
      'provider-attachments/preserved.txt',
    );
    expect(cleanupMaterialization).not.toHaveBeenCalledWith(
      'attachments/workspace-live.txt',
    );
    expect(warn).toHaveBeenCalledWith(
      { errorCode: 'EACCES' },
      'Failed to clean removed provider attachment materialization',
    );
    warn.mockRestore();
  });

  it('uses explicit provider account when saving inbound channel messages', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      select: vi.fn(),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(),
    };
    const graph = {
      findConversationIdForJid: vi.fn(async () => undefined),
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
    expect(graph.findConversationIdForJid).not.toHaveBeenCalled();
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
            return {
              onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
            };
          }),
        })),
        delete: vi.fn(),
      };
      const repository = new PostgresCanonicalMessageRepository({} as never);
      Object.assign(repository, {
        graph: {
          findConversationIdForJid: vi.fn(async () => undefined),
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
      execute: vi.fn(async () => undefined),
      select: liveAdmissionSelectMock(),
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
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(),
    };
    const graph = {
      findConversationIdForJid: vi.fn(async () => undefined),
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
    expect(graph.findConversationIdForJid).not.toHaveBeenCalled();
    expect(insertedValues[0]).toMatchObject({
      id: 'message:slack_beta:sl:C123:1710000001.000100',
      providerAccountId: 'slack_beta',
    });
  });

  it('agent-qualifies live admission work item identity and queue jid', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      execute: vi.fn(async () => undefined),
      select: liveAdmissionSelectMock(),
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
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(),
    };
    const graph = {
      findConversationIdForJid: vi.fn(async () => undefined),
      ensureConversation: vi.fn(
        async () =>
          'conversation:channel-providerAccount:default:slack:sl:C123',
      ),
      ensureThread: vi.fn(
        async () =>
          'thread:channel-providerAccount:default:slack:sl:C123:thread-1',
      ),
      getConversationInstallationId: vi.fn(async () => null),
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
    const messageRow = insertedValues[0];

    expect(graph.ensureConversation).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        providerAccountId: 'channel-providerAccount:default:slack',
      }),
      tx,
    );
    expect(graph.ensureThread).toHaveBeenCalledWith(
      'sl:C123',
      'thread-1',
      tx,
      expect.objectContaining({
        providerAccountId: 'channel-providerAccount:default:slack',
      }),
    );
    expect(graph.getConversationInstallationId).not.toHaveBeenCalled();
    expect(graph.findConversationIdForJid).toHaveBeenCalledWith('sl:C123', tx);
    expect(graph.ensureParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId:
          'conversation:channel-providerAccount:default:slack:sl:C123',
        providerAccountId: 'channel-providerAccount:default:slack',
      }),
      tx,
    );
    expect(messageRow).toMatchObject({
      id: 'message:channel-providerAccount:default:slack:sl:C123:1710000001.000100',
      providerAccountId: 'channel-providerAccount:default:slack',
      conversationId:
        'conversation:channel-providerAccount:default:slack:sl:C123',
      threadId: 'thread:channel-providerAccount:default:slack:sl:C123:thread-1',
    });

    expect(admissionRow).toMatchObject({
      id: 'live-admission:app-one:agent:alpha:channel-providerAccount:default:slack:message:channel-providerAccount:default:slack:sl:C123:1710000001.000100',
      agentId: 'agent:alpha',
      queueJid:
        'sl:C123::thread:thread-1::agent:agent%3Aalpha::provider_account:channel-providerAccount%3Adefault%3Aslack',
      idempotencyKey:
        'live-admission:app-one:agent:alpha:channel-providerAccount:default:slack:sl:C123:thread-1:1710000001.000100',
    });
  });

  it('stamps the internal control provider account for providerless app-session admission', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      execute: vi.fn(async () => undefined),
      select: liveAdmissionSelectMock(),
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
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(),
    };
    const graph = {
      findConversationIdForJid: vi.fn(async () => undefined),
      ensureConversation: vi.fn(
        async () => 'conversation:control:default:app:default:haiku-e2e',
      ),
      ensureThread: vi.fn(async () => null),
      getConversationInstallationId: vi.fn(async () => null),
      ensureParticipant: vi.fn(async () => undefined),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, { graph });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000002.000200',
        chat_jid: 'app:default:haiku-e2e',
        sender: 'api',
        sender_name: 'API',
        content: 'hello',
        timestamp: '2026-05-06T00:00:00.000Z',
      },
      { liveAdmission: { appId: 'app-one', agentId: 'alpha' } },
    );

    // The internal app channel is bound as control:<appId>; any other
    // synthetic account orphans the conversation from channel ownership and
    // the turn is silently skipped ("No channel owns JID").
    expect(graph.ensureConversation).toHaveBeenCalledWith(
      'app:default:haiku-e2e',
      expect.objectContaining({ providerAccountId: 'control:default' }),
      tx,
    );
    expect(insertedValues[0]).toMatchObject({
      id: 'message:control:default:app:default:haiku-e2e:1710000002.000200',
      providerAccountId: 'control:default',
    });
    const admissionRow = insertedValues.find(
      (value): value is Record<string, unknown> =>
        !!value &&
        typeof value === 'object' &&
        String((value as Record<string, unknown>).id).startsWith(
          'live-admission:',
        ),
    );
    expect(String(admissionRow?.queueJid)).toContain(
      'provider_account:control%3Adefault',
    );
    expect(String(admissionRow?.queueJid)).not.toContain(
      'channel-providerAccount',
    );
  });

  it('reuses an existing conversation installation for providerless live admission', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      execute: vi.fn(async () => undefined),
      select: liveAdmissionSelectMock(),
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
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(),
    };
    const existingConversationId = 'conversation:slack_install:sl:C-existing';
    const graph = {
      findConversationIdForJid: vi.fn(async () => existingConversationId),
      getConversationInstallationId: vi.fn(async () => 'slack_install'),
      ensureConversation: vi.fn(async () => existingConversationId),
      ensureThread: vi.fn(
        async () => 'thread:slack_install:sl:C-existing:thread-1',
      ),
      ensureParticipant: vi.fn(async () => undefined),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, { graph });

    await repository.saveMessageWithExecutor(
      tx as never,
      {
        id: '1710000002.000100',
        chat_jid: 'sl:C-existing',
        provider: 'slack',
        sender: 'U123',
        sender_name: 'Ravi',
        content: '@Alpha follow-up',
        timestamp: '2026-05-06T00:00:01.000Z',
        thread_id: 'thread-1',
      },
      { liveAdmission: { appId: 'app-one', agentId: 'alpha' } },
    );

    expect(graph.findConversationIdForJid).toHaveBeenCalledWith(
      'sl:C-existing',
      tx,
    );
    expect(graph.getConversationInstallationId).toHaveBeenCalledWith(
      existingConversationId,
      tx,
    );
    expect(graph.ensureConversation).toHaveBeenCalledWith(
      'sl:C-existing',
      expect.objectContaining({ providerAccountId: 'slack_install' }),
      tx,
    );
    expect(
      graph.findConversationIdForJid.mock.invocationCallOrder[0],
    ).toBeLessThan(graph.ensureConversation.mock.invocationCallOrder[0] ?? 0);

    expect(insertedValues[0]).toMatchObject({
      id: 'message:slack_install:sl:C-existing:1710000002.000100',
      providerAccountId: 'slack_install',
      conversationId: existingConversationId,
      threadId: 'thread:slack_install:sl:C-existing:thread-1',
    });
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        queueJid:
          'sl:C-existing::thread:thread-1::agent:agent%3Aalpha::provider_account:slack_install',
        messageId: 'message:slack_install:sl:C-existing:1710000002.000100',
      }),
    );
  });

  it('preserves stored attachment refs unless explicit identities conflict', async () => {
    const insertedValues: unknown[] = [];
    const tx = {
      execute: vi.fn(async () => undefined),
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
              id: 'matching-attachment-id',
              externalRefJson: {
                kind: 'message_attachment',
                value: 'matching-provider-external',
              },
              storageRef: 'artifact-by-matching-id',
            },
            {
              id: 'stored-external-null-id',
              externalRefJson: null,
              storageRef: 'artifact-by-null-external-id',
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
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
    const repository = new PostgresCanonicalMessageRepository({} as never);
    Object.assign(repository, {
      graph: {
        findConversationIdForJid: vi.fn(async () => undefined),
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
            id: 'matching-attachment-id',
            kind: 'file',
            externalId: 'matching-provider-external',
          },
          {
            id: 'stored-external-null-id',
            kind: 'file',
            externalId: 'new-provider-external-for-stored-null',
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
          storageRef: null,
        }),
        expect.objectContaining({
          id: 'old-generated-id',
          storageRef: 'artifact-by-external-id',
        }),
        expect.objectContaining({
          id: 'matching-attachment-id',
          storageRef: 'artifact-by-matching-id',
        }),
        expect.objectContaining({
          id: 'stored-external-null-id',
          storageRef: 'artifact-by-null-external-id',
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

  it('publishes an opaque live admission wakeup only after the transaction commits', async () => {
    const order: string[] = [];
    let commitTransaction!: () => void;
    const transactionCommitted = new Promise<{
      outcome: 'enqueued';
      item: { id: string; appId: string };
    }>((resolve) => {
      commitTransaction = () => {
        order.push('transaction committed');
        resolve({
          outcome: 'enqueued',
          item: {
            id: 'live-admission:default:message-1',
            appId: 'default',
          },
        });
      };
    });
    const notifyLiveAdmissionWorkItem = vi.fn(async () => {
      order.push('admission notified');
    });
    const saveMessage = vi.fn(() => transactionCommitted);
    const service = new CanonicalMessageOpsService(
      { saveMessage } as unknown as PostgresCanonicalMessageRepository,
      { notifyLiveAdmissionWorkItem },
    );

    const storing = service.storeMessageWithLiveAdmission(
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

    await vi.waitFor(() => expect(saveMessage).toHaveBeenCalledOnce());
    expect(notifyLiveAdmissionWorkItem).not.toHaveBeenCalled();

    commitTransaction();
    await storing;

    expect(order).toEqual(['transaction committed', 'admission notified']);
    expect(notifyLiveAdmissionWorkItem).toHaveBeenCalledWith({
      appId: 'default',
      workItemId: 'live-admission:default:message-1',
    });
    expect(
      JSON.stringify(notifyLiveAdmissionWorkItem.mock.calls),
    ).not.toContain('sensitive body');
  });

  it('does not publish a wakeup for overloaded admission', async () => {
    const notifyLiveAdmissionWorkItem = vi.fn(async () => {});
    const service = new CanonicalMessageOpsService(
      {
        saveMessage: vi.fn(async () => ({ outcome: 'overloaded' as const })),
      } as unknown as PostgresCanonicalMessageRepository,
      { notifyLiveAdmissionWorkItem },
    );

    await expect(
      service.storeMessageWithLiveAdmission(
        {
          id: 'provider-message-overloaded',
          chat_jid: 'tg:one',
          provider: 'telegram',
          sender: '42',
          sender_name: 'Ravi',
          content: 'canonical but not admitted',
          timestamp: '2026-05-06T00:00:01.000Z',
        },
        { appId: 'default' },
      ),
    ).resolves.toEqual({ outcome: 'overloaded' });
    expect(notifyLiveAdmissionWorkItem).not.toHaveBeenCalled();
  });
});
