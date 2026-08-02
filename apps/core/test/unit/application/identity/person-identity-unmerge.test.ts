import { describe, expect, it } from 'vitest';

import {
  mergeUndoSnapshot,
  restorePersonalMemory,
} from '@core/adapters/storage/postgres/repositories/person-identity-mappers.postgres.js';

const sourcePerson = {
  personId: 'person-source',
  appId: 'app-one',
  kind: 'human',
  displayName: 'Source',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function audit(resultJson: Record<string, unknown>) {
  return {
    id: 'audit-1',
    appId: 'app-one',
    sourcePersonId: 'person-source',
    targetPersonId: 'person-target',
    resultJson,
  } as never;
}

describe('person identity unmerge audit', () => {
  it('restores only aliases and memory rows recorded by the merge', () => {
    const movedAlias = {
      id: 'alias-moved',
      appId: 'app-one',
      personId: 'person-source',
      provider: 'email',
      externalUserId: 'source@example.com',
      verificationStatus: 'unverified',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const snapshot = mergeUndoSnapshot(
      audit({
        sourcePerson,
        aliasesToMove: [movedAlias],
        movedAliasIds: ['alias-moved'],
        movedMemoryIds: ['memory-moved'],
        movedMemoryRows: [{ id: 'memory-moved', subjectId: 'msu_original' }],
        movedParticipantIds: [],
        supersededMemoryRows: [{ id: 'memory-moved', priorStatus: 'active' }],
        fingerprint: 'sha256:preview',
      }),
    );

    expect(snapshot.aliasesToMove).toEqual([movedAlias]);
    expect(snapshot.movedAliasIds).toEqual(['alias-moved']);
    expect(snapshot.movedAliasIds).not.toContain('alias-added-after-merge');
    expect(snapshot.movedMemoryIds).toEqual(['memory-moved']);
  });

  it('refuses audit rows without exact reversible memory identity', () => {
    expect(() =>
      mergeUndoSnapshot(
        audit({
          sourcePerson,
          aliasesToMove: [],
          movedAliasIds: [],
          fingerprint: 'sha256:preview',
        }),
      ),
    ).toThrow('Merge audit does not contain the complete reversible state.');
  });
});

describe('person identity unmerge memory restore', () => {
  function fakeExecutor(selectResults: Array<Array<Record<string, unknown>>>) {
    let call = 0;
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      for: () => Promise.resolve(selectResults[call++] ?? []),
    };
    return {
      select: () => chain,
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      execute: () => Promise.resolve(),
    } as never;
  }

  it('refuses when a superseded row status changed after the merge', async () => {
    const executor = fakeExecutor([
      [{ id: 'memory-moved' }],
      [{ id: 'memory-superseded', status: 'active' }],
    ]);
    await expect(
      restorePersonalMemory(executor, {
        appId: 'app-one',
        sourcePersonId: 'person-source',
        targetPersonId: 'person-target',
        movedMemoryIds: ['memory-moved'],
        movedMemoryRows: [{ id: 'memory-moved', subjectId: 'msu_original' }],
        movedParticipantIds: [],
        supersededMemoryRows: [
          { id: 'memory-superseded', priorStatus: 'active' },
        ],
        timestamp: '2026-01-02T00:00:00.000Z',
      }),
    ).rejects.toThrow('changed after the merge');
  });
});
