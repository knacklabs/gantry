import { describe, expect, it } from 'vitest';

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
