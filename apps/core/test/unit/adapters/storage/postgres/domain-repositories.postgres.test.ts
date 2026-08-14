import { describe, expect, it, vi } from 'vitest';

import {
  createPostgresDomainRepositories,
  parseRuntimeSecretRefsJson,
  PostgresConversationRepository,
  PostgresMessageRepository,
  PostgresProviderAccountRepository,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import { PostgresOutboundDeliveryRepository } from '@core/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.js';
import { PostgresAgentCreationDraftRepository } from '@core/adapters/storage/postgres/repositories/agent-creation-draft-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import {
  conversationInstallsPostgres,
  providerAccountsPostgres,
} from '@core/adapters/storage/postgres/schema/providers.js';

function messageUpsertResult(inserted = false) {
  return {
    returning: vi.fn(async () => [{ inserted }]),
  };
}

describe('createPostgresDomainRepositories', () => {
  it('wires outbound delivery repository into the domain bundle', () => {
    const repositories = createPostgresDomainRepositories({} as never);
    expect(repositories.outboundDeliveries).toBeInstanceOf(
      PostgresOutboundDeliveryRepository,
    );
    expect(repositories.providerAccounts).toBeInstanceOf(
      PostgresProviderAccountRepository,
    );
    expect(repositories.agentCreationDrafts).toBeInstanceOf(
      PostgresAgentCreationDraftRepository,
    );
  });
});

describe('provider account schema', () => {
  it('persists ownership and native identity evidence without trigger routing', () => {
    expect(providerAccountsPostgres.agentId.name).toBe('agent_id');
    expect(providerAccountsPostgres.externalIdentityRefJson.name).toBe(
      'external_identity_ref_json',
    );
    expect(conversationInstallsPostgres.providerAccountId.name).toBe(
      'provider_account_id',
    );
    expect(conversationInstallsPostgres.senderPolicy.name).toBe(
      'sender_policy',
    );
    expect(conversationInstallsPostgres).not.toHaveProperty('triggerPattern');
    expect(conversationInstallsPostgres).not.toHaveProperty('requiresTrigger');
  });
});

describe('agent creation draft schema', () => {
  it('keeps draft state app-scoped, revisioned, and separate from the agent record', () => {
    expect(pgSchema.agentCreationDraftsPostgres.appId.name).toBe('app_id');
    expect(pgSchema.agentCreationDraftsPostgres.revision.name).toBe('revision');
    expect(pgSchema.agentCreationDraftsPostgres.documentJson.name).toBe(
      'document_json',
    );
    expect(pgSchema.agentCreationDraftsPostgres.agentId.name).toBe('agent_id');
  });
});

describe('PostgresConversationRepository', () => {
  it('persists an authoritative-empty approver row without exposing it', async () => {
    const rows: Record<string, unknown>[] = [];
    const values = vi.fn(async (value: Record<string, unknown>[]) => {
      rows.push(...value);
    });
    const tx = {
      delete: vi.fn(() => ({
        where: vi.fn(async () => {
          rows.length = 0;
        }),
      })),
      insert: vi.fn(() => ({ values })),
    };
    const db = {
      transaction: vi.fn(async (run: (transaction: typeof tx) => unknown) =>
        run(tx),
      ),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(async () => rows),
          })),
        })),
      })),
    };
    const repository = new PostgresConversationRepository(db as never);

    const approvers = await repository.replaceConversationApprovers({
      appId: 'app-one' as never,
      conversationId: 'conversation:one' as never,
      externalUserIds: [],
      updatedAt: '2026-07-15T00:00:00.000Z',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        conversationId: 'conversation:one',
        externalUserId: '',
      }),
    ]);
    expect(approvers).toEqual([]);
    await expect(
      repository.listConversationApproversForConversations([
        'conversation:one' as never,
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId: 'conversation:one',
        externalUserId: '',
      }),
    ]);
  });
});

describe('PostgresMessageRepository', () => {
  it('does not preserve attachment state when the external identity conflicts', async () => {
    let insertedAttachmentRows: Array<{
      storageRef: string | null;
      fileName: string | null;
      providerFetchJson: unknown;
      deletedAt: string | null;
    }> = [];
    const cleanupMaterialization = vi.fn(async (_storageRef: string) => {});
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  providerAccountId: 'slack-account',
                  providerId: 'slack',
                },
              ]),
            })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              id: 'attachment-1',
              externalRefJson: {
                kind: 'message_attachment',
                value: 'old-provider-file-id',
              },
              storageRef: 'provider-attachments/old-file.txt',
              fileName: 'old-file.txt',
              contentType: 'text/plain',
              sizeBytes: 123,
              providerFetchJson: {
                provider: 'slack',
                kind: 'file_id',
                id: 'old-provider-file-id',
              },
              deletedAt: '2026-07-30T12:00:00.000Z',
            },
          ]),
        })),
      });
    const writeTx = {
      execute: vi.fn(async () => undefined),
      select,
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          if (Array.isArray(values)) {
            insertedAttachmentRows = values as typeof insertedAttachmentRows;
          }
          return {
            onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
          };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
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
    let transactionCall = 0;
    const db = {
      transaction: vi.fn(
        async (
          run: (
            transaction: typeof writeTx | typeof cleanupTx,
          ) => Promise<unknown>,
        ) => run(transactionCall++ === 0 ? writeTx : cleanupTx),
      ),
    };
    const repository = new PostgresMessageRepository(
      db as never,
      cleanupMaterialization,
    );

    await repository.saveMessage({
      id: 'message-1',
      appId: 'app-1',
      conversationId: 'conversation-1',
      direction: 'inbound',
      trust: 'trusted',
      createdAt: '2026-07-31T00:00:00.000Z',
      parts: [],
      attachments: [
        {
          id: 'attachment-1',
          kind: 'file',
          trust: 'trusted',
          externalRef: {
            kind: 'message_attachment',
            value: 'new-provider-file-id',
          },
        },
      ],
    } as never);

    expect(insertedAttachmentRows).toHaveLength(1);
    expect(insertedAttachmentRows[0]).toMatchObject({
      storageRef: null,
      fileName: null,
      providerFetchJson: null,
      deletedAt: null,
    });
    expect(cleanupMaterialization).toHaveBeenCalledWith(
      'provider-attachments/old-file.txt',
    );
  });

  it('drops an incoming provider ref when no current attachment row carries it', async () => {
    let insertedAttachmentRows: Array<{ storageRef: string | null }> = [];
    const select = vi.fn().mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                providerAccountId: 'slack-account',
                providerId: 'slack',
              },
            ]),
          })),
        })),
      })),
    });
    const tx = {
      execute: vi.fn(async () => undefined),
      select,
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: unknown) => {
          if (Array.isArray(values)) {
            insertedAttachmentRows = values as Array<{
              storageRef: string | null;
            }>;
          }
          return {
            onConflictDoUpdate: vi.fn(() =>
              messageUpsertResult(table === pgSchema.messagesPostgres),
            ),
          };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
      ),
    };
    const repository = new PostgresMessageRepository(db as never);

    await repository.saveMessage({
      id: 'message-1',
      appId: 'app-1',
      conversationId: 'conversation-1',
      direction: 'inbound',
      trust: 'trusted',
      createdAt: '2026-07-31T00:00:00.000Z',
      parts: [],
      attachments: [
        {
          id: 'attachment-1',
          kind: 'file',
          trust: 'trusted',
          storageRef: 'provider-attachments/reclaimed-report.txt',
        },
      ],
    } as never);

    expect(insertedAttachmentRows).toHaveLength(1);
    expect(insertedAttachmentRows[0]?.storageRef).toBeNull();
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.delete).not.toHaveBeenCalledWith(
      pgSchema.messageAttachmentsPostgres,
    );
  });

  it('skips unlink when a stale domain save restores the ref before cleanup revalidation', async () => {
    let committed = false;
    const operations: string[] = [];
    const cleanupMaterialization = vi.fn(async (_storageRef: string) => {});
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  providerAccountId: 'slack-account',
                  providerId: 'slack',
                },
              ]),
            })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              id: 'dropped-attachment',
              storageRef: 'provider-attachments/dropped.txt',
            },
          ]),
        })),
      });
    const tx = {
      execute: vi.fn(async () => undefined),
      select,
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => messageUpsertResult()),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    };
    const cleanupTx = {
      execute: vi.fn(async () => {
        expect(committed).toBe(true);
        operations.push('cleanup:lock');
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              operations.push('cleanup:recheck-restored');
              return [{ id: 'restored-attachment' }];
            }),
          })),
        })),
      })),
    };
    let transactionCall = 0;
    const db = {
      transaction: vi.fn(
        async (
          run: (transaction: typeof tx | typeof cleanupTx) => Promise<unknown>,
        ) => {
          if (transactionCall++ === 0) {
            const result = await run(tx);
            committed = true;
            operations.push('save:commit');
            return result;
          }
          return run(cleanupTx);
        },
      ),
    };
    const repository = new PostgresMessageRepository(
      db as never,
      cleanupMaterialization,
    );

    await repository.saveMessage({
      id: 'message-1',
      appId: 'app-1',
      conversationId: 'conversation-1',
      direction: 'inbound',
      trust: 'trusted',
      createdAt: '2026-07-31T00:00:00.000Z',
      parts: [{ kind: 'text', text: 'replacement' }],
      attachments: [],
    } as never);

    expect(operations).toEqual([
      'save:commit',
      'cleanup:lock',
      'cleanup:lock',
      'cleanup:recheck-restored',
    ]);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(cleanupMaterialization).not.toHaveBeenCalled();
  });
});

describe('parseRuntimeSecretRefsJson', () => {
  it('parses credential-keyed runtime secret refs', () => {
    expect(
      parseRuntimeSecretRefsJson(
        '{"bot_token":"env:SLACK_BOT_TOKEN"}',
        'slack',
      ),
    ).toEqual({ bot_token: 'env:SLACK_BOT_TOKEN' });
  });

  it('rejects array-shaped runtime secret refs', () => {
    expect(() =>
      parseRuntimeSecretRefsJson('["SLACK_BOT_TOKEN"]', 'slack'),
    ).toThrow(
      'provider account slack runtimeSecretRefs must be a JSON object keyed by credential name',
    );
  });
});
