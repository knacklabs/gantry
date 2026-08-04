import { describe, expect, it, vi } from 'vitest';

import { PostgresSettingsRevisionRepository } from '@core/adapters/storage/postgres/repositories/settings-revision-repository.postgres.js';
import type { CanonicalDb } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';

interface FakeRow {
  appId: string;
  revision: number;
  settingsDocumentJson: Record<string, unknown>;
  minReaderVersion: number;
  createdBy: string;
  note: string | null;
  createdAt: string;
}

interface FakeDbState {
  rows: FakeRow[];
  /**
   * Canned per-call responses for the next `getLatestSettingsRevision` reads
   * (shifted per select). Lets a test pin a STALE head read so the conditional
   * insert reaches the unique-violation race path instead of the pre-check.
   */
  cannedLatest: Array<FakeRow | null>;
}

/**
 * Minimal drizzle-shaped fake: SELECT returns the canned (or real) head row,
 * INSERT enforces the (app_id, revision) unique key by throwing the pg
 * SQLSTATE 23505 shape `isUniqueViolation` matches.
 */
function fakeDb(state: FakeDbState): CanonicalDb {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (count: number) => {
              if (state.cannedLatest.length > 0) {
                const next = state.cannedLatest.shift();
                return next ? [next] : [];
              }
              return [...state.rows]
                .sort((a, b) => b.revision - a.revision)
                .slice(0, count);
            },
          }),
        }),
      }),
    }),
    insert: () => ({
      values: async (row: FakeRow) => {
        if (
          state.rows.some(
            (existing) =>
              existing.appId === row.appId &&
              existing.revision === row.revision,
          )
        ) {
          throw Object.assign(
            new Error(
              'duplicate key value violates unique constraint "settings_revisions_pk"',
            ),
            { code: '23505' },
          );
        }
        state.rows.push(row);
      },
    }),
  } as unknown as CanonicalDb;
}

function row(revision: number): FakeRow {
  return {
    appId: 'default',
    revision,
    settingsDocumentJson: { rev: revision },
    minReaderVersion: 1,
    createdBy: 'seed',
    note: null,
    createdAt: '2026-06-11T00:00:00.000Z',
  };
}

function appendInput(expectedRevision?: number | null) {
  return {
    appId: 'default',
    settingsDocument: { agent: {} },
    minReaderVersion: 1,
    createdBy: 'test',
    expectedRevision,
    now: '2026-06-11T01:00:00.000Z',
  };
}

describe('PostgresSettingsRevisionRepository.appendSettingsRevision', () => {
  it('conditionally appends exactly expectedRevision + 1 when the head matches', async () => {
    const state: FakeDbState = { rows: [row(1)], cannedLatest: [] };
    const repository = new PostgresSettingsRevisionRepository(fakeDb(state));

    const result = await repository.appendSettingsRevision(appendInput(1));

    expect(result.status).toBe('appended');
    if (result.status === 'appended') {
      expect(result.revision.revision).toBe(2);
    }
    expect(state.rows.map((r) => r.revision).sort()).toEqual([1, 2]);
  });

  it('returns a conflict for a stale expected revision without inserting', async () => {
    const state: FakeDbState = { rows: [row(1), row(2)], cannedLatest: [] };
    const repository = new PostgresSettingsRevisionRepository(fakeDb(state));

    const result = await repository.appendSettingsRevision(appendInput(1));

    expect(result).toEqual({
      status: 'conflict',
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(state.rows).toHaveLength(2);
  });

  it('race path: the loser of a concurrent same-expectation insert gets a conflict, never the next revision', async () => {
    const state: FakeDbState = { rows: [row(1)], cannedLatest: [] };
    const repository = new PostgresSettingsRevisionRepository(fakeDb(state));

    // Writer A wins: head matched, revision 2 inserted.
    const winner = await repository.appendSettingsRevision(appendInput(1));
    expect(winner.status).toBe('appended');

    // Writer B raced A: its head read was STALE (still revision 1), so its
    // pre-check passes and the conditional insert of revision 2 hits the
    // unique key. That must surface as a conflict — not retry into revision 3.
    state.cannedLatest.push(row(1));
    const loser = await repository.appendSettingsRevision(appendInput(1));

    expect(loser).toEqual({
      status: 'conflict',
      expectedRevision: 1,
      actualRevision: 2,
    });
    // Exactly one new revision exists; the lost update never landed.
    expect(state.rows.map((r) => r.revision).sort()).toEqual([1, 2]);
  });

  it('conditional append from an empty head uses expectedRevision 0', async () => {
    const state: FakeDbState = { rows: [], cannedLatest: [] };
    const repository = new PostgresSettingsRevisionRepository(fakeDb(state));

    const result = await repository.appendSettingsRevision(appendInput(0));

    expect(result.status).toBe('appended');
    if (result.status === 'appended') {
      expect(result.revision.revision).toBe(1);
    }
  });

  it('rejects a changed MCP source binding before publishing the settings revision', async () => {
    const lockedRows = [
      {
        id: 'agent-mcp-binding:agent:test:mcp:sum',
        appId: 'default',
        agentId: 'agent:test',
        serverId: 'mcp:sum',
        status: 'disabled',
        allowedToolPatternsJson: '["get-sum"]',
        updatedAt: '2026-07-21T12:01:00.000Z',
      },
    ];
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const rowLock = { for: vi.fn(async () => lockedRows) };
    const tx = {
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => (selectCall === 1 ? agentLock : rowLock),
          }),
        };
      }),
      insert: vi.fn(),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresSettingsRevisionRepository(db as never);

    await expect(
      repository.appendSettingsRevision({
        ...appendInput(1),
        expectedMcpBindings: [
          {
            id: 'agent-mcp-binding:agent:test:mcp:sum' as never,
            appId: 'default' as never,
            agentId: 'agent:test' as never,
            serverId: 'mcp:sum' as never,
            status: 'active',
            required: false,
            permissionPolicyIds: [],
            allowedToolPatterns: ['get-sum'],
            createdAt: '2026-07-21T12:00:00.000Z' as never,
            updatedAt: '2026-07-21T12:00:00.000Z' as never,
          },
        ],
      }),
    ).rejects.toThrow(
      'MCP source binding mcp:sum changed during capability approval',
    );
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(rowLock.for).toHaveBeenCalledWith('update');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('persists the semantic MCP source fence with the revision while preserving its note', async () => {
    const precondition = {
      id: 'agent-mcp-binding:agent:test:mcp:sum',
      appId: 'default',
      agentId: 'agent:test',
      serverId: 'mcp:sum',
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['get-sum'],
    } as const;
    const lockedRows = [
      {
        ...precondition,
        permissionPolicyIdsJson: '[]',
        allowedToolPatternsJson: '["get-sum"]',
        conversationId: null,
        threadId: null,
        updatedAt: '2026-07-21 12:00:00+00',
      },
    ];
    const agentLock = { for: vi.fn(async () => []) };
    const rowLock = { for: vi.fn(async () => lockedRows) };
    const insertedValues = vi.fn(async () => undefined);
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({ where: () => agentLock }),
        })
        .mockReturnValueOnce({
          from: () => ({ where: () => rowLock }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: async () => [row(1)] }),
            }),
          }),
        }),
      insert: vi.fn(() => ({ values: insertedValues })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresSettingsRevisionRepository(db as never);

    const result = await repository.appendSettingsRevision({
      ...appendInput(1),
      note: 'human approval',
      expectedMcpBindings: [precondition as never],
      mcpCapabilityGrantTokens: {
        '["main_agent","mcp.sum.read.reviewed","catalog"]':
          'permission-request:mcp-sum',
      },
    });

    expect(result).toMatchObject({
      status: 'appended',
      revision: {
        note: 'human approval',
        mcpBindingPreconditions: [precondition],
        mcpCapabilityGrantTokens: {
          '["main_agent","mcp.sum.read.reviewed","catalog"]':
            'permission-request:mcp-sum',
        },
      },
    });
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(rowLock.for).toHaveBeenCalledWith('update');
    expect(insertedValues).toHaveBeenCalledOnce();
  });

  it('persists an explicit empty MCP binding set for a fenced agent', async () => {
    const agentLock = { for: vi.fn(async () => []) };
    const rowLock = { for: vi.fn(async () => []) };
    const insertedValues = vi.fn(async () => undefined);
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({ where: () => agentLock }),
        })
        .mockReturnValueOnce({
          from: () => ({ where: () => rowLock }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: async () => [row(1)] }),
            }),
          }),
        }),
      insert: vi.fn(() => ({ values: insertedValues })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresSettingsRevisionRepository(db as never);

    const result = await repository.appendSettingsRevision({
      ...appendInput(1),
      expectedMcpBindingAgentIds: ['agent:test' as never],
      expectedMcpBindings: [],
    });

    expect(result).toMatchObject({
      status: 'appended',
      revision: {
        mcpBindingPreconditionAgentIds: ['agent:test'],
        mcpBindingPreconditions: [],
      },
    });
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(rowLock.for).toHaveBeenCalledWith('update');
    expect(insertedValues).toHaveBeenCalledOnce();
  });

  it('unconditional append keeps the allocate-and-retry behavior past a violation', async () => {
    const state: FakeDbState = { rows: [row(1)], cannedLatest: [null] };
    const repository = new PostgresSettingsRevisionRepository(fakeDb(state));

    // First attempt reads a stale empty head (canned), inserts revision 1,
    // hits the unique key, then retries against the real head and lands 2.
    const result = await repository.appendSettingsRevision(appendInput(null));

    expect(result.status).toBe('appended');
    if (result.status === 'appended') {
      expect(result.revision.revision).toBe(2);
    }
  });
});
