import { describe, expect, it, vi } from 'vitest';

import { PostgresPermissionDecisionMemoryRepository } from '@core/adapters/storage/postgres/repositories/permission-decision-memory-repository.postgres.js';
import { AllowOnceNeverPersistedError } from '@core/domain/ports/permission-decision-memory.js';

function flattenSqlShape(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => flattenSqlShape(entry, seen)).join(' ');
  }
  const record = value as Record<string | symbol, unknown>;
  return [
    flattenSqlShape(record.value, seen),
    typeof record.name === 'string' ? record.name : '',
    flattenSqlShape(record.queryChunks, seen),
    flattenSqlShape(record.config, seen),
  ].join(' ');
}

function decisionMemoryRow(input: {
  lookupIdentity: string;
  expiresAt: string | null;
}) {
  return {
    id: `row:${input.lookupIdentity}`,
    appId: 'app',
    agentFolder: 'main_agent',
    kind: 'classifier_verdict',
    lookupIdentity: input.lookupIdentity,
    effectHash: input.lookupIdentity,
    decision: 'allow',
    reason: 'cached allow',
    riskLevel: 'low',
    riskCategory: null,
    canonicalRoot: null,
    principal: null,
    effectSchemaVersion: 1,
    railVersion: 1,
    provenance: 'classifier',
    createdAt: '2026-07-12T00:00:00.000Z',
    expiresAt: input.expiresAt,
    revokedAt: null,
  };
}

function readDb(
  rows: ReturnType<typeof decisionMemoryRow>[],
  expiredLookupIdentities: string[] = [],
) {
  const expired = new Set(expiredLookupIdentities);
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((predicate: unknown) => {
          const sqlShape = flattenSqlShape(predicate);
          const hasActiveExpiryPredicate =
            sqlShape.includes('expires_at') &&
            sqlShape.includes(' is null') &&
            sqlShape.includes(' or ') &&
            sqlShape.includes(' > ') &&
            sqlShape.includes('now()');
          const filtered = hasActiveExpiryPredicate
            ? rows.filter((row) => !expired.has(row.lookupIdentity))
            : rows;
          return Object.assign(filtered, {
            limit: vi.fn(async (limit: number) => filtered.slice(0, limit)),
          });
        }),
      })),
    })),
  } as unknown as ConstructorParameters<
    typeof PostgresPermissionDecisionMemoryRepository
  >[0];
}

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

describe('permission decision memory active reads', () => {
  const get = async (expiresAt: string | null, expired = false) => {
    const row = decisionMemoryRow({
      lookupIdentity: 'effect-read',
      expiresAt,
    });
    const repository = new PostgresPermissionDecisionMemoryRepository(
      readDb([row], expired ? [row.lookupIdentity] : []),
    );
    return repository.get({
      appId: row.appId,
      agentFolder: row.agentFolder,
      kind: 'classifier_verdict',
      lookupIdentity: row.lookupIdentity,
    });
  };

  it('does not return an expired allow from get', async () => {
    await expect(get('2000-01-01T00:00:00.000Z', true)).resolves.toBeNull();
  });

  it('returns a future-dated allow from get', async () => {
    await expect(get('2999-01-01T00:00:00.000Z')).resolves.toMatchObject({
      decision: 'allow',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
  });

  it('returns a NULL-expiry allow from get', async () => {
    await expect(get(null)).resolves.toMatchObject({
      decision: 'allow',
      expiresAt: undefined,
    });
  });

  it('excludes expired rows from list while retaining future and NULL expiry rows', async () => {
    const rows = [
      decisionMemoryRow({
        lookupIdentity: 'effect-expired',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
      decisionMemoryRow({
        lookupIdentity: 'effect-future',
        expiresAt: '2999-01-01T00:00:00.000Z',
      }),
      decisionMemoryRow({
        lookupIdentity: 'effect-no-expiry',
        expiresAt: null,
      }),
    ];
    const repository = new PostgresPermissionDecisionMemoryRepository(
      readDb(rows, ['effect-expired']),
    );

    await expect(
      repository.list({
        appId: 'app',
        agentFolder: 'main_agent',
        kind: 'classifier_verdict',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ lookupIdentity: 'effect-future' }),
      expect.objectContaining({ lookupIdentity: 'effect-no-expiry' }),
    ]);
  });
});
