import { describe, expect, it, vi } from 'vitest';
import { PostgresMessageTraceRepository } from '@core/adapters/storage/postgres/repositories/message-trace-repository.postgres.js';

const row = {
  messageId: 'message:jid:m1',
  appId: 'a',
  conversationId: 'c',
  kind: 'reply' as const,
  totalMs: 5,
  timingsJson: { version: 1 as const, totalMs: 5, stages: [] },
  payloadsJson: null,
  createdAt: '2026-06-14T00:00:00.000Z',
};

describe('PostgresMessageTraceRepository', () => {
  it('inserts a trace row via onConflictDoNothing', async () => {
    const captured: unknown[] = [];
    const fakeDb = {
      insert: () => ({
        values: (v: unknown) => ({
          onConflictDoNothing: async () => {
            captured.push(v);
          },
        }),
      }),
    };
    const repo = new PostgresMessageTraceRepository(fakeDb as never);
    await repo.save(row);
    expect((captured[0] as { messageId: string }).messageId).toBe(
      'message:jid:m1',
    );
  });

  it('never throws into the reply path on a db error', async () => {
    const warn = vi.fn();
    const throwingDb = {
      insert: () => {
        throw new Error('db down');
      },
    };
    const repo = new PostgresMessageTraceRepository(throwingDb as never, {
      warn,
    });
    await expect(repo.save(row)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws when onConflictDoNothing rejects', async () => {
    const rejectingDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            throw new Error('constraint exploded');
          },
        }),
      }),
    };
    const repo = new PostgresMessageTraceRepository(rejectingDb as never);
    await expect(repo.save(row)).resolves.toBeUndefined();
  });
});
