import { describe, expect, it, vi } from 'vitest';

import { PostgresPermissionDecisionMemoryRepository } from '@core/adapters/storage/postgres/repositories/permission-decision-memory-repository.postgres.js';
import { AllowOnceNeverPersistedError } from '@core/domain/ports/permission-decision-memory.js';

// Stub db whose insert throws a sentinel — proves whether the write path reached
// the database or was short-circuited by the allow_once guard first.
const DB_REACHED = new Error('db-reached');
const stubDb = {
  insert() {
    throw DB_REACHED;
  },
} as unknown as ConstructorParameters<
  typeof PostgresPermissionDecisionMemoryRepository
>[0];

const repo = new PostgresPermissionDecisionMemoryRepository(stubDb);

const base = {
  appId: 'app',
  agentFolder: 'main_agent',
  effectHash: 'effect-1',
  reason: 'r',
  risk_level: 'low',
  effectSchemaVersion: 1,
  railVersion: 1,
  provenance: 'p',
  nowIso: '2026-07-12T00:00:00.000Z',
} as const;

describe('permission decision memory allow_once guard', () => {
  it('refuses a human allow_once before touching the database', async () => {
    await expect(
      repo.putClassifierVerdict({
        ...base,
        decision: 'allow',
        sourceMode: 'allow_once',
      }),
    ).rejects.toBeInstanceOf(AllowOnceNeverPersistedError);
  });

  it('lets a genuine classifier verdict through to the write path', async () => {
    // Reaching the db sentinel proves the guard passed a non-allow_once verdict.
    await expect(
      repo.putClassifierVerdict({ ...base, decision: 'allow' }),
    ).rejects.toBe(DB_REACHED);
  });

  it('round-trips classifier risk metadata through the verdict cache methods', async () => {
    let stored:
      | Parameters<PostgresPermissionDecisionMemoryRepository['put']>[0]
      | undefined;
    const repository = new PostgresPermissionDecisionMemoryRepository(
      {} as ConstructorParameters<
        typeof PostgresPermissionDecisionMemoryRepository
      >[0],
    );
    repository.put = vi.fn(async (input) => {
      stored = input;
    });
    repository.get = vi.fn(async () =>
      stored
        ? {
            ...stored,
            createdAt: stored.nowIso,
          }
        : null,
    );

    await repository.putClassifierVerdict({
      ...base,
      decision: 'allow',
      risk_level: 'low',
      risk_category: 'filesystem',
    });

    await expect(
      repository.getClassifierVerdict({
        appId: base.appId,
        agentFolder: base.agentFolder,
        effectHash: base.effectHash,
      }),
    ).resolves.toEqual({
      decision: 'allow',
      reason: base.reason,
      risk_level: 'low',
      risk_category: 'filesystem',
    });
  });
});
