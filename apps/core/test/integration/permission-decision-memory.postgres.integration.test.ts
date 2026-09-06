import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { permissionDecisionMemoryPostgres } from '@core/adapters/storage/postgres/schema/schema.js';
import {
  AllowOnceNeverPersistedError,
  HumanDecisionRequiresTypedAccessError,
  type HumanDecisionMemoryPutInput,
} from '@core/domain/ports/permission-decision-memory.js';
import { encodeHumanDecisionProvenance } from '@core/domain/human-decision.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP = 'app-one';
const FOLDER = 'main_agent';

maybeDescribe('Postgres permission decision memory', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'permission_decision_memory',
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('keeps the classifier verdict cache byte-identical, refuses a human_decision kind through the non-human put, get, list and revoke while an unfiltered non-human list excludes human rows, and refuses a malformed id or missing human field through putHumanDecision before any SQL', async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    await repository.putClassifierVerdict({
      appId: APP,
      agentFolder: FOLDER,
      effectHash: 'effect-abc',
      decision: 'allow',
      reason: 'routine read',
      risk_level: 'low',
      risk_category: 'filesystem',
      effectSchemaVersion: 1,
      railVersion: 3,
      provenance: 'classifier',
      nowIso: '2026-07-12T00:00:00.000Z',
    });

    await expect(
      repository.getClassifierVerdict({
        appId: APP,
        agentFolder: FOLDER,
        effectHash: 'effect-abc',
      }),
    ).resolves.toEqual({
      decision: 'allow',
      reason: 'routine read',
      risk_level: 'low',
      risk_category: 'filesystem',
    });

    // A different hash is a genuine cache miss.
    await expect(
      repository.getClassifierVerdict({
        appId: APP,
        agentFolder: FOLDER,
        effectHash: 'effect-other',
      }),
    ).resolves.toBeNull();

    const humanInput: HumanDecisionMemoryPutInput = {
      id: '10000000-0000-4000-8000-000000000010',
      appId: APP,
      agentFolder: FOLDER,
      outcome: 'allow',
      scope: 'exact',
      scopeKey: 'exact:non-human-guard',
      actingPersonId: 'person-non-human-guard',
      canonicalTool: 'WebSearch',
      reason: 'remember search',
      effectSchemaVersion: 1,
      railVersion: 3,
      provenance: encodeHumanDecisionProvenance({
        id: '10000000-0000-4000-8000-000000000010',
        actingPersonId: 'person-non-human-guard',
        outcome: 'allow',
        scope: 'exact',
        railVersion: 3,
      }),
      nowIso: '2026-07-12T00:01:00.000Z',
      effectHash: 'effect-human-non-human-guard',
    };
    await repository.putHumanDecision(humanInput);

    await expect(
      repository.put({
        ...humanInput,
        kind: 'human_decision',
        lookupIdentity: humanInput.scopeKey,
      }),
    ).rejects.toBeInstanceOf(HumanDecisionRequiresTypedAccessError);
    await expect(
      repository.get({
        appId: APP,
        agentFolder: FOLDER,
        kind: 'human_decision',
        lookupIdentity: humanInput.scopeKey,
      }),
    ).rejects.toBeInstanceOf(HumanDecisionRequiresTypedAccessError);
    await expect(
      repository.list({
        appId: APP,
        agentFolder: FOLDER,
        kind: 'human_decision',
      }),
    ).rejects.toBeInstanceOf(HumanDecisionRequiresTypedAccessError);
    await expect(
      repository.revoke({
        appId: APP,
        agentFolder: FOLDER,
        kind: 'human_decision',
        lookupIdentity: humanInput.scopeKey,
        nowIso: '2026-07-12T00:02:00.000Z',
      }),
    ).rejects.toBeInstanceOf(HumanDecisionRequiresTypedAccessError);
    await expect(
      repository.list({ appId: APP, agentFolder: FOLDER }),
    ).resolves.not.toContainEqual(
      expect.objectContaining({ kind: 'human_decision' }),
    );

    const transaction = vi.spyOn(runtime.service.db, 'transaction');
    try {
      await expect(
        repository.putHumanDecision({ ...humanInput, id: 'not-a-uuid' }),
      ).rejects.toThrow();

      for (const [index, field] of (
        ['outcome', 'scope', 'scopeKey', 'actingPersonId'] as const
      ).entries()) {
        const id = `10000000-0000-4000-8000-00000000002${index}`;
        const invalid: Partial<HumanDecisionMemoryPutInput> = {
          ...humanInput,
          id,
          provenance: encodeHumanDecisionProvenance({
            id,
            actingPersonId: humanInput.actingPersonId,
            outcome: humanInput.outcome,
            scope: humanInput.scope,
            railVersion: humanInput.railVersion,
          }),
        };
        delete invalid[field];
        await expect(
          repository.putHumanDecision(invalid as HumanDecisionMemoryPutInput),
        ).rejects.toThrow();
      }
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it('hydrates NULL optional columns as undefined (not null)', async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    await repository.putClassifierVerdict({
      appId: APP,
      agentFolder: FOLDER,
      effectHash: 'effect-hydrate',
      decision: 'ask',
      reason: 'needs review',
      risk_level: 'high',
      effectSchemaVersion: 1,
      railVersion: 3,
      provenance: 'classifier',
      nowIso: '2026-07-12T00:00:00.000Z',
    });

    const row = await repository.get({
      appId: APP,
      agentFolder: FOLDER,
      kind: 'classifier_verdict',
      lookupIdentity: 'effect-hydrate',
    });

    expect(row).not.toBeNull();
    // The unset optional columns are NULL in Postgres — the hydration boundary
    // must coerce them to `undefined` so downstream `=== undefined` checks work.
    expect(row?.canonicalRoot).toBeUndefined();
    expect(row?.principal).toBeUndefined();
    expect(row?.expiresAt).toBeUndefined();
    expect(row?.revokedAt).toBeUndefined();
    expect('canonicalRoot' in (row ?? {})).toBe(true);
    expect(row?.canonicalRoot).not.toBeNull();
  });

  it.each([
    {
      label: 'past',
      effectHash: 'effect-expired',
      expiresAt: '2000-01-01T00:00:00.000Z',
      returned: false,
    },
    {
      label: 'future',
      effectHash: 'effect-future',
      expiresAt: '2999-01-01T00:00:00.000Z',
      returned: true,
    },
    {
      label: 'NULL',
      effectHash: 'effect-no-expiry',
      expiresAt: undefined,
      returned: true,
    },
  ])(
    'returns only active rows when expires_at is $label',
    async ({ effectHash, expiresAt, returned }) => {
      const repository = runtime.repositories.permissionDecisionMemory;
      await repository.putClassifierVerdict({
        appId: APP,
        agentFolder: FOLDER,
        effectHash,
        decision: 'allow',
        reason: 'expiry test',
        risk_level: 'low',
        effectSchemaVersion: 1,
        railVersion: 3,
        provenance: 'classifier',
        nowIso: '2026-07-12T00:00:00.000Z',
        expiresAt,
      });

      const result = await repository.get({
        appId: APP,
        agentFolder: FOLDER,
        kind: 'classifier_verdict',
        lookupIdentity: effectHash,
      });
      if (returned) {
        expect(result).toMatchObject({ lookupIdentity: effectHash });
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it('enforces the partial keys: non-human rows keep the four-column key, two active human rows for one person and scope key reject, a revoked human row admits a fresh row, two persons coexist, and the human-row CHECK rejects each missing field while a missing label is accepted', async () => {
    const base = {
      appId: APP,
      agentFolder: FOLDER,
      kind: 'trusted_root',
      lookupIdentity: '/repo/root',
      reason: 'owner trusted root',
      effectSchemaVersion: 1,
      railVersion: 3,
      provenance: 'owner',
      createdAt: '2026-07-12T00:00:00.000Z',
    };
    // Raw inserts bypass the repo upsert to prove the DB constraint rejects a
    // second row on the same lookup key.
    await runtime.service.db
      .insert(permissionDecisionMemoryPostgres)
      .values({ ...base, id: 'row-a' });
    await expect(
      runtime.service.db
        .insert(permissionDecisionMemoryPostgres)
        .values({ ...base, id: 'row-b' }),
    ).rejects.toThrow();

    const humanBase = {
      appId: APP,
      agentFolder: FOLDER,
      kind: 'human_decision',
      lookupIdentity: 'exact:partial-key',
      decision: 'allow',
      outcome: 'allow',
      scope: 'exact',
      scopeKey: 'exact:partial-key',
      actingPersonId: 'person-partial-key',
      actingPersonLabel: 'Pat',
      reason: 'remembered by Pat',
      principal: 'WebSearch',
      effectSchemaVersion: 1,
      railVersion: 3,
      provenance: 'human_decision:raw-constraint-test',
      createdAt: '2026-07-12T01:00:00.000Z',
    };
    await runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
      ...humanBase,
      id: '20000000-0000-4000-8000-000000000001',
    });
    await expect(
      runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
        ...humanBase,
        id: '20000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toThrow();

    const revokedBase = {
      ...humanBase,
      lookupIdentity: 'exact:history-key',
      scopeKey: 'exact:history-key',
      actingPersonId: 'person-history-key',
    };
    await runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
      ...revokedBase,
      id: '20000000-0000-4000-8000-000000000003',
      revokedAt: '2026-07-12T01:01:00.000Z',
    });
    await runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
      ...revokedBase,
      id: '20000000-0000-4000-8000-000000000004',
    });

    const sharedScope = {
      ...humanBase,
      lookupIdentity: 'exact:shared-key',
      scopeKey: 'exact:shared-key',
    };
    await runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
      ...sharedScope,
      id: '20000000-0000-4000-8000-000000000005',
      actingPersonId: 'person-shared-a',
    });
    await runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
      ...sharedScope,
      id: '20000000-0000-4000-8000-000000000006',
      actingPersonId: 'person-shared-b',
    });

    for (const [index, missing] of (
      ['outcome', 'scope', 'scopeKey', 'actingPersonId'] as const
    ).entries()) {
      const key = `exact:check-${index}`;
      await expect(
        runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
          ...humanBase,
          id: `20000000-0000-4000-8000-00000000001${index}`,
          lookupIdentity: key,
          outcome: missing === 'outcome' ? null : humanBase.outcome,
          scope: missing === 'scope' ? null : humanBase.scope,
          scopeKey: missing === 'scopeKey' ? null : key,
          actingPersonId:
            missing === 'actingPersonId' ? null : `person-check-${index}`,
        }),
      ).rejects.toThrow();
    }

    await runtime.service.db.insert(permissionDecisionMemoryPostgres).values({
      ...humanBase,
      id: '20000000-0000-4000-8000-000000000020',
      lookupIdentity: 'exact:no-label',
      scopeKey: 'exact:no-label',
      actingPersonId: 'person-no-label',
      actingPersonLabel: null,
    });
  });

  it('round-trips human decisions per person: putHumanDecision refreshes an active duplicate in place returning the stored id and status refreshed with the complete refresh set - outcome, decision, reason, label, effect hash, rail version, effect schema version, created_at and provenance re-encoded with the stored id - inserts a fresh row beside a revoked one without reactivating it, listHumanDecisions is person-scoped and newest first with includeRevoked defaulting to active rows only and true returning revoked rows with their revokedAt, revokeById returns applied then already_revoked and not_found across persons and across app and agent folder, and countExactAllowsByTool counts active exact allows by principal', async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    const firstId = '30000000-0000-4000-8000-000000000001';
    const person = 'person-round-trip';
    const scopeKey = 'exact:path:file:workspace/notes.md';
    const first: HumanDecisionMemoryPutInput = {
      id: firstId,
      appId: APP,
      agentFolder: FOLDER,
      outcome: 'allow',
      scope: 'exact',
      scopeKey,
      actingPersonId: person,
      actingPersonLabel: 'Pat',
      canonicalTool: 'file',
      reason: 'allow this write',
      effectSchemaVersion: 1,
      railVersion: 3,
      provenance: encodeHumanDecisionProvenance({
        id: firstId,
        actingPersonId: person,
        outcome: 'allow',
        scope: 'exact',
        railVersion: 3,
      }),
      nowIso: '2026-07-12T02:00:00.000Z',
      effectHash: 'effect-before-refresh',
    };
    await expect(repository.putHumanDecision(first)).resolves.toEqual({
      id: firstId,
      status: 'inserted',
    });

    const discardedId = '30000000-0000-4000-8000-000000000002';
    const refreshed: HumanDecisionMemoryPutInput = {
      ...first,
      id: discardedId,
      outcome: 'deny',
      actingPersonLabel: 'Pat Updated',
      reason: 'deny this write now',
      effectSchemaVersion: 2,
      railVersion: 4,
      provenance: encodeHumanDecisionProvenance({
        id: discardedId,
        actingPersonId: person,
        outcome: 'deny',
        scope: 'exact',
        railVersion: 4,
      }),
      nowIso: '2026-07-12T02:01:00.000Z',
      effectHash: 'effect-after-refresh',
    };
    await expect(repository.putHumanDecision(refreshed)).resolves.toEqual({
      id: firstId,
      status: 'refreshed',
    });
    await expect(
      repository.listHumanDecisions({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: firstId,
        lookupIdentity: scopeKey,
        outcome: 'deny',
        decision: 'deny',
        reason: 'deny this write now',
        actingPersonLabel: 'Pat Updated',
        effectHash: 'effect-after-refresh',
        effectSchemaVersion: 2,
        railVersion: 4,
        principal: 'file',
        createdAt: '2026-07-12T02:01:00.000Z',
        provenance: encodeHumanDecisionProvenance({
          id: firstId,
          actingPersonId: person,
          outcome: 'deny',
          scope: 'exact',
          railVersion: 4,
        }),
      }),
    ]);

    const otherPersonId = '30000000-0000-4000-8000-000000000003';
    await repository.putHumanDecision({
      ...first,
      id: otherPersonId,
      actingPersonId: 'person-round-trip-other',
      provenance: encodeHumanDecisionProvenance({
        id: otherPersonId,
        actingPersonId: 'person-round-trip-other',
        outcome: 'allow',
        scope: 'exact',
        railVersion: 3,
      }),
      nowIso: '2026-07-12T02:02:00.000Z',
    });
    await expect(
      repository.listHumanDecisions({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: 'person-round-trip-other',
      }),
    ).resolves.toEqual([expect.objectContaining({ id: otherPersonId })]);

    for (const axis of [
      { appId: APP, agentFolder: FOLDER, actingPersonId: 'another-person' },
      { appId: 'another-app', agentFolder: FOLDER, actingPersonId: person },
      { appId: APP, agentFolder: 'another-folder', actingPersonId: person },
    ]) {
      await expect(
        repository.revokeById({
          ...axis,
          recordId: firstId,
          nowIso: '2026-07-12T02:03:00.000Z',
        }),
      ).resolves.toBe('not_found');
    }
    await expect(
      repository.revokeById({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        recordId: firstId,
        nowIso: '2026-07-12T02:03:00.000Z',
      }),
    ).resolves.toBe('applied');
    await expect(
      repository.revokeById({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        recordId: firstId,
        nowIso: '2026-07-12T02:03:30.000Z',
      }),
    ).resolves.toBe('already_revoked');
    await expect(
      repository.listHumanDecisions({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listHumanDecisions({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        includeRevoked: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: firstId,
        revokedAt: '2026-07-12T02:03:00.000Z',
      }),
    ]);

    const freshId = '30000000-0000-4000-8000-000000000004';
    const fresh: HumanDecisionMemoryPutInput = {
      ...first,
      id: freshId,
      provenance: encodeHumanDecisionProvenance({
        id: freshId,
        actingPersonId: person,
        outcome: 'allow',
        scope: 'exact',
        railVersion: 3,
      }),
      nowIso: '2026-07-12T02:04:00.000Z',
    };
    await expect(repository.putHumanDecision(fresh)).resolves.toEqual({
      id: freshId,
      status: 'inserted',
    });
    await expect(
      repository.listHumanDecisions({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: freshId })]);
    await expect(
      repository.listHumanDecisions({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        includeRevoked: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: freshId, revokedAt: undefined }),
      expect.objectContaining({
        id: firstId,
        revokedAt: '2026-07-12T02:03:00.000Z',
      }),
    ]);

    const webReadId = '30000000-0000-4000-8000-000000000005';
    await repository.putHumanDecision({
      ...fresh,
      id: webReadId,
      scopeKey: 'exact:web-read',
      canonicalTool: 'WebRead',
      provenance: encodeHumanDecisionProvenance({
        id: webReadId,
        actingPersonId: person,
        outcome: 'allow',
        scope: 'exact',
        railVersion: 3,
      }),
      nowIso: '2026-07-12T02:05:00.000Z',
    });
    const denyId = '30000000-0000-4000-8000-000000000006';
    await repository.putHumanDecision({
      ...fresh,
      id: denyId,
      outcome: 'deny',
      scopeKey: 'exact:deny',
      canonicalTool: 'WebRead',
      provenance: encodeHumanDecisionProvenance({
        id: denyId,
        actingPersonId: person,
        outcome: 'deny',
        scope: 'exact',
        railVersion: 3,
      }),
      nowIso: '2026-07-12T02:06:00.000Z',
    });
    const kindId = '30000000-0000-4000-8000-000000000007';
    await repository.putHumanDecision({
      ...fresh,
      id: kindId,
      scope: 'kind',
      scopeKey: 'kind:web_read',
      canonicalTool: 'WebRead',
      provenance: encodeHumanDecisionProvenance({
        id: kindId,
        actingPersonId: person,
        outcome: 'allow',
        scope: 'kind',
        railVersion: 3,
      }),
      nowIso: '2026-07-12T02:07:00.000Z',
    });
    await expect(
      repository.countExactAllowsByTool({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
      }),
    ).resolves.toEqual({ file: 1, WebRead: 1 });
    await expect(
      repository.countExactAllowsByTool({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: 'person-round-trip-other',
      }),
    ).resolves.toEqual({ file: 1 });
    await expect(
      repository.countExactAllowsByTool({
        appId: 'another-app',
        agentFolder: FOLDER,
        actingPersonId: person,
      }),
    ).resolves.toEqual({});
    await expect(
      repository.countExactAllowsByTool({
        appId: APP,
        agentFolder: 'another-folder',
        actingPersonId: person,
      }),
    ).resolves.toEqual({});

    const concurrentPerson = 'person-concurrent';
    const concurrentScopeKey = 'exact:path:file:workspace/concurrent.md';
    const concurrentInputs = [
      '30000000-0000-4000-8000-000000000008',
      '30000000-0000-4000-8000-000000000009',
    ].map(
      (id, index): HumanDecisionMemoryPutInput => ({
        ...first,
        id,
        actingPersonId: concurrentPerson,
        scopeKey: concurrentScopeKey,
        provenance: encodeHumanDecisionProvenance({
          id,
          actingPersonId: concurrentPerson,
          outcome: 'allow',
          scope: 'exact',
          railVersion: 3,
        }),
        nowIso: `2026-07-12T02:08:0${index}.000Z`,
      }),
    );
    const concurrentResults = await Promise.all(
      concurrentInputs.map((input) => repository.putHumanDecision(input)),
    );
    expect(concurrentResults.map(({ status }) => status).sort()).toEqual([
      'inserted',
      'refreshed',
    ]);
    expect(new Set(concurrentResults.map(({ id }) => id)).size).toBe(1);
    await expect(
      repository.listHumanDecisions({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: concurrentPerson,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: concurrentResults[0]!.id }),
    ]);
  });

  it('revoke hides the row via the active index', async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    await repository.put({
      id: 'grant-1',
      appId: APP,
      agentFolder: FOLDER,
      kind: 'standing_grant',
      lookupIdentity: 'main_agent|mcp__github__get_issue',
      decision: 'allow',
      reason: 'owner standing grant',
      effectSchemaVersion: 1,
      railVersion: 3,
      provenance: 'owner',
      nowIso: '2026-07-12T00:00:00.000Z',
    });

    await expect(
      repository.get({
        appId: APP,
        agentFolder: FOLDER,
        kind: 'standing_grant',
        lookupIdentity: 'main_agent|mcp__github__get_issue',
      }),
    ).resolves.not.toBeNull();

    await expect(
      repository.revoke({
        appId: APP,
        agentFolder: FOLDER,
        kind: 'standing_grant',
        lookupIdentity: 'main_agent|mcp__github__get_issue',
        nowIso: '2026-07-12T01:00:00.000Z',
      }),
    ).resolves.toBe(true);

    await expect(
      repository.get({
        appId: APP,
        agentFolder: FOLDER,
        kind: 'standing_grant',
        lookupIdentity: 'main_agent|mcp__github__get_issue',
      }),
    ).resolves.toBeNull();

    // The revoked row still occupies its raw slot until re-put reactivates it.
    const raw = await runtime.service.db
      .select()
      .from(permissionDecisionMemoryPostgres)
      .where(
        and(
          eq(permissionDecisionMemoryPostgres.id, 'grant-1'),
          eq(permissionDecisionMemoryPostgres.appId, APP),
        ),
      );
    expect(raw).toHaveLength(1);
    expect(raw[0]?.revokedAt).not.toBeNull();
  });

  it('refuses to persist a human allow_once', async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    await expect(
      repository.putClassifierVerdict({
        appId: APP,
        agentFolder: FOLDER,
        effectHash: 'effect-never',
        decision: 'allow',
        reason: 'human clicked allow once',
        risk_level: 'low',
        effectSchemaVersion: 1,
        railVersion: 3,
        provenance: 'human',
        nowIso: '2026-07-12T00:00:00.000Z',
        sourceMode: 'allow_once',
      }),
    ).rejects.toBeInstanceOf(AllowOnceNeverPersistedError);

    // Nothing was written.
    await expect(
      repository.getClassifierVerdict({
        appId: APP,
        agentFolder: FOLDER,
        effectHash: 'effect-never',
      }),
    ).resolves.toBeNull();
  });
});
