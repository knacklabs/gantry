import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PostgresMessageAttachmentRepository } from '@core/adapters/storage/postgres/repositories/message-attachment-repository.postgres.js';
import { reclaimTombstonedProviderAttachment } from '@core/adapters/storage/postgres/repositories/provider-attachment-cleanup.postgres.js';

describe('PostgresMessageAttachmentRepository', () => {
  it('routes a displaced self-heal ref through reference-aware post-commit cleanup', async () => {
    const operations: string[] = [];
    const cleanupMaterialization = vi.fn(async (storageRef: string) => {
      operations.push(`store:remove:${storageRef}`);
    });
    const claimSelect = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ messageId: 'message-1' }]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  messageId: 'message-1',
                  appId: 'app-1',
                  conversationId: 'conversation-1',
                  providerAccountId: 'provider-account-1',
                  providerFetch: {
                    provider: 'slack',
                    kind: 'file_id',
                    id: 'F1',
                  },
                  storageRef: 'provider-attachments/unreadable-old.txt',
                },
              ]),
            })),
          })),
        })),
      });
    const set = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [
          {
            storageRef: 'provider-attachments/fresh.txt',
            fileName: 'report.txt',
            contentType: 'text/plain',
            sizeBytes: 13,
          },
        ]),
      })),
    }));
    const claimTx = {
      execute: vi.fn(async () => {
        operations.push('claim:lock');
      }),
      select: claimSelect,
      update: vi.fn(() => ({ set })),
    };
    const cleanupTx = {
      execute: vi.fn(async () => {
        operations.push('cleanup:lock');
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              operations.push('cleanup:unreferenced');
              return [];
            }),
          })),
        })),
      })),
    };
    let transactionCall = 0;
    const db = {
      transaction: vi.fn(
        async (
          run: (
            transaction: typeof claimTx | typeof cleanupTx,
          ) => Promise<unknown>,
        ) => {
          if (transactionCall++ === 0) {
            const result = await run(claimTx);
            operations.push('claim:commit');
            return result;
          }
          return run(cleanupTx);
        },
      ),
    };
    const repository = new PostgresMessageAttachmentRepository(
      db as never,
      cleanupMaterialization,
    );

    await expect(
      repository.setStorageRefIfAbsent({
        attachmentId: 'attachment-1',
        expectedMessageId: 'message-1',
        expectedAppId: 'app-1',
        expectedConversationId: 'conversation-1' as never,
        expectedProviderAccountId: 'provider-account-1',
        expectedProviderFetch: {
          provider: 'slack',
          kind: 'file_id',
          id: 'F1',
        },
        expectedStorageRef: 'provider-attachments/unreadable-old.txt',
        storageRef: 'provider-attachments/fresh.txt',
        fileName: 'report.txt',
        contentType: 'text/plain',
        sizeBytes: 13,
      }),
    ).resolves.toEqual({
      status: 'materialized',
      attachment: {
        storageRef: 'provider-attachments/fresh.txt',
        fileName: 'report.txt',
        contentType: 'text/plain',
        sizeBytes: 13,
      },
    });

    expect(set).toHaveBeenCalledWith({
      storageRef: 'provider-attachments/fresh.txt',
      fileName: 'report.txt',
      contentType: 'text/plain',
      sizeBytes: 13,
    });
    expect(operations).toEqual([
      'claim:lock',
      'claim:commit',
      'cleanup:lock',
      'cleanup:unreferenced',
      'store:remove:provider-attachments/unreadable-old.txt',
    ]);
    expect(cleanupMaterialization).toHaveBeenCalledWith(
      'provider-attachments/unreadable-old.txt',
    );
    expect(cleanupMaterialization).not.toHaveBeenCalledWith(
      'provider-attachments/fresh.txt',
    );
  });

  it('unlinks a tombstoned materialization before clearing its durable retry ref', async () => {
    const operations: string[] = [];
    const cleanupMaterialization = vi.fn(async () => {
      operations.push('cleanup:unlink');
    });
    const set = vi.fn(() => ({
      where: vi.fn(async () => {
        operations.push('cleanup:cas');
      }),
    }));
    const tx = {
      execute: vi.fn(async () => {
        operations.push('cleanup:lock');
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              operations.push('cleanup:unreferenced');
              return [];
            }),
          })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    };
    const db = {
      transaction: vi.fn(
        async (run: (transaction: typeof tx) => Promise<void>) => run(tx),
      ),
    };

    await reclaimTombstonedProviderAttachment(
      db as never,
      {
        attachmentId: 'attachment-1',
        messageId: 'message-1',
        storageRef: 'provider-attachments/pending-delete.txt',
      },
      cleanupMaterialization,
    );

    expect(operations).toEqual([
      'cleanup:lock',
      'cleanup:unreferenced',
      'cleanup:unlink',
      'cleanup:cas',
    ]);
    expect(set).toHaveBeenCalledWith({ storageRef: null });
  });

  it('keeps shared bytes when tombstone cleanup finds another row reference', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-tombstone-shared-ref-'),
    );
    const materializedPath = path.join(tempDir, 'shared.txt');
    fs.writeFileSync(materializedPath, 'shared bytes');
    const operations: string[] = [];
    const cleanupMaterialization = vi.fn(async () => {
      fs.rmSync(materializedPath, { force: true });
      operations.push('unlink');
    });
    const tombstoneSelect = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ messageId: 'message-1' }]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  messageId: 'message-1',
                  appId: 'app-1',
                  conversationId: 'conversation-1',
                  providerAccountId: 'provider-account-1',
                  providerFetch: {
                    provider: 'slack',
                    kind: 'file_id',
                    id: 'F1',
                  },
                  storageRef: 'provider-attachments/shared.txt',
                },
              ]),
            })),
          })),
        })),
      });
    const tombstoneSet = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: 'attachment-1' }]),
      })),
    }));
    const tombstoneTx = {
      execute: vi.fn(async () => undefined),
      select: tombstoneSelect,
      update: vi.fn(() => ({ set: tombstoneSet })),
    };
    const cleanupSet = vi.fn(() => ({
      where: vi.fn(async () => {
        operations.push('cleanup:cas');
      }),
    }));
    const cleanupTx = {
      execute: vi.fn(async () => {
        operations.push('cleanup:lock');
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              operations.push('cleanup:shared-ref');
              return [{ id: 'attachment-2' }];
            }),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: cleanupSet })),
    };
    let transactionCall = 0;
    const db = {
      transaction: vi.fn(
        async (
          run: (
            transaction: typeof tombstoneTx | typeof cleanupTx,
          ) => Promise<unknown>,
        ) => {
          if (transactionCall++ === 0) {
            const result = await run(tombstoneTx);
            operations.push('tombstone:commit');
            return result;
          }
          return run(cleanupTx);
        },
      ),
    };
    const repository = new PostgresMessageAttachmentRepository(
      db as never,
      cleanupMaterialization,
    );

    try {
      await expect(
        repository.setDeletedAt({
          attachmentId: 'attachment-1',
          expectedMessageId: 'message-1',
          expectedAppId: 'app-1',
          expectedConversationId: 'conversation-1' as never,
          expectedProviderAccountId: 'provider-account-1',
          expectedProviderFetch: {
            provider: 'slack',
            kind: 'file_id',
            id: 'F1',
          },
          deletedAt: '2026-07-31T00:00:00.000Z',
        }),
      ).resolves.toEqual({
        tombstoned: true,
        storageRef: 'provider-attachments/shared.txt',
      });

      expect(tombstoneSet).toHaveBeenCalledWith({
        deletedAt: '2026-07-31T00:00:00.000Z',
      });
      expect(cleanupSet).toHaveBeenCalledWith({ storageRef: null });
      expect(operations).toEqual([
        'tombstone:commit',
        'cleanup:lock',
        'cleanup:shared-ref',
        'cleanup:cas',
      ]);
      expect(cleanupMaterialization).not.toHaveBeenCalled();
      expect(fs.readFileSync(materializedPath, 'utf8')).toBe('shared bytes');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
