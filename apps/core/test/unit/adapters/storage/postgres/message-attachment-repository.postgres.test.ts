import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PostgresMessageAttachmentRepository } from '@core/adapters/storage/postgres/repositories/message-attachment-repository.postgres.js';

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
    const set = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: 'attachment-1' }]),
      })),
    }));
    const tombstoneTx = {
      execute: vi.fn(async () => undefined),
      select: tombstoneSelect,
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
              operations.push('cleanup:shared-ref');
              return [{ id: 'attachment-2' }];
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

      expect(set).toHaveBeenCalledWith({
        deletedAt: '2026-07-31T00:00:00.000Z',
        storageRef: null,
      });
      expect(operations).toEqual([
        'tombstone:commit',
        'cleanup:lock',
        'cleanup:shared-ref',
      ]);
      expect(cleanupMaterialization).not.toHaveBeenCalled();
      expect(fs.readFileSync(materializedPath, 'utf8')).toBe('shared bytes');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
