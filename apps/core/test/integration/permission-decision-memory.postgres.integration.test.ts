import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { permissionDecisionMemoryPostgres } from '@core/adapters/storage/postgres/schema/schema.js';
import { HumanDecisionMemoryService } from '@core/application/permissions/human-decision-memory-service.js';
import { projectHumanDecisionMatch } from '@core/application/permissions/human-decision-job-projection.js';
import { PermissionManagementService } from '@core/application/permissions/permission-management-service.js';
import {
  AllowOnceNeverPersistedError,
  HumanDecisionRequiresTypedAccessError,
  type HumanDecisionMemoryPutInput,
} from '@core/domain/ports/permission-decision-memory.js';
import { encodeHumanDecisionProvenance } from '@core/domain/human-decision.js';
import { RAIL_CATALOG_VERSION } from '@core/domain/permission-effect-key.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

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
  }, 60_000);

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
        railVersion: 3,
      }),
    ).resolves.toEqual({ file: 1, WebRead: 1 });
    await expect(
      repository.countExactAllowsByTool({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: 'person-round-trip-other',
        railVersion: 3,
      }),
    ).resolves.toEqual({ file: 1 });
    await expect(
      repository.countExactAllowsByTool({
        appId: 'another-app',
        agentFolder: FOLDER,
        actingPersonId: person,
        railVersion: 3,
      }),
    ).resolves.toEqual({});
    await expect(
      repository.countExactAllowsByTool({
        appId: APP,
        agentFolder: 'another-folder',
        actingPersonId: person,
        railVersion: 3,
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

  it('counts only current-rail-version active exact Allows per tool so three older-version rows do not unlock trust growth', async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    const person = 'person-rail-count';
    for (let index = 0; index < 5; index += 1) {
      // Own id range: the candidate-key leaf above seeds 4000…0001-0004 and
      // this suite has no per-test cleanup.
      const id = `40000000-0000-4000-8000-0000000000c${index + 1}`;
      const railVersion =
        index < 3 ? RAIL_CATALOG_VERSION - 1 : RAIL_CATALOG_VERSION;
      await repository.putHumanDecision({
        id,
        appId: APP,
        agentFolder: FOLDER,
        outcome: 'allow',
        scope: 'exact',
        scopeKey: `exact:rail-count:${index}`,
        actingPersonId: person,
        canonicalTool: 'FileWrite',
        reason: 'rail-filtered count fixture',
        effectSchemaVersion: 1,
        railVersion,
        provenance: encodeHumanDecisionProvenance({
          id,
          actingPersonId: person,
          outcome: 'allow',
          scope: 'exact',
          railVersion,
        }),
        nowIso: `2026-09-08T00:00:0${index}.000Z`,
      });
    }

    await expect(
      repository.countExactAllowsByTool({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        railVersion: RAIL_CATALOG_VERSION,
      }),
    ).resolves.toEqual({ FileWrite: 2 });
  });

  it('lists one latest use per job by human decision record id from the durable audit rows written on both job lanes ordered by most recent use and ignores unrelated rows and other apps', async () => {
    const recordId = '70000000-0000-4000-8000-000000000001';
    const record = async (input: {
      appId?: string;
      humanDecisionRecordId: string;
      jobId: string;
      now: string;
      toolName: string;
    }) =>
      new PermissionManagementService({ now: () => input.now }).recordDecision({
        appId: (input.appId ?? APP) as never,
        agentId: 'agent-one' as never,
        requestId: `audit-${input.toolName}`,
        toolName: input.toolName,
        decision: { approved: true, decidedBy: 'human_decision' },
        permissionRepository: runtime.repositories.permissions,
        jobId: input.jobId,
        auditMetadata: { humanDecisionRecordId: input.humanDecisionRecordId },
      });

    await record({
      humanDecisionRecordId: recordId,
      jobId: 'job-ipc',
      now: '2026-09-02T00:00:00.000Z',
      toolName: 'IPC job lane',
    });
    await record({
      humanDecisionRecordId: recordId,
      jobId: 'job-inline',
      now: '2026-09-03T00:00:00.000Z',
      toolName: 'inline job lane',
    });
    await record({
      humanDecisionRecordId: recordId,
      jobId: 'job-ipc',
      now: '2026-09-04T00:00:00.000Z',
      toolName: 'IPC job lane retry',
    });
    await record({
      humanDecisionRecordId: '70000000-0000-4000-8000-000000000002',
      jobId: 'job-unrelated',
      now: '2026-09-05T00:00:00.000Z',
      toolName: 'unrelated memory',
    });
    await record({
      appId: 'another-app',
      humanDecisionRecordId: recordId,
      jobId: 'job-other-app',
      now: '2026-09-06T00:00:00.000Z',
      toolName: 'other app memory',
    });

    await expect(
      runtime.repositories.permissions.listDecisionsByHumanDecisionRecordId({
        appId: APP,
        recordIds: [recordId],
      }),
    ).resolves.toEqual([
      {
        recordId,
        jobId: 'job-ipc',
        lastUsedAt: '2026-09-04T00:00:00.000Z',
      },
      {
        recordId,
        jobId: 'job-inline',
        lastUsedAt: '2026-09-03T00:00:00.000Z',
      },
    ]);
  });

  it("finds a human decision by ordered candidate keys for one person, app and folder only: the first of two matching candidates wins, a revoked row, another person's row and a row from another rails version never match, and no row yields null", async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    const person = 'person-find-human-decision';
    const put = async (
      id: string,
      scope: HumanDecisionMemoryPutInput['scope'],
      scopeKey: string,
      overrides: Partial<HumanDecisionMemoryPutInput> = {},
    ) =>
      repository.putHumanDecision({
        id,
        appId: APP,
        agentFolder: FOLDER,
        outcome: 'allow',
        scope,
        scopeKey,
        actingPersonId: person,
        canonicalTool: 'WebRead',
        reason: 'remembered lookup',
        effectSchemaVersion: 3,
        railVersion: 2,
        provenance: encodeHumanDecisionProvenance({
          id,
          actingPersonId: overrides.actingPersonId ?? person,
          outcome: overrides.outcome ?? 'allow',
          scope,
          railVersion: overrides.railVersion ?? 2,
        }),
        nowIso: '2026-09-07T00:00:00.000Z',
        ...overrides,
      });

    const exactId = '40000000-0000-4000-8000-000000000001';
    const kindId = '40000000-0000-4000-8000-000000000002';
    await put(exactId, 'exact', 'effect-find-exact');
    await put(kindId, 'kind', 'kind:web_read');
    await expect(
      repository.findHumanDecision({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        candidates: [
          { scope: 'kind', scopeKey: 'kind:web_read' },
          { scope: 'exact', scopeKey: 'effect-find-exact' },
        ],
        railVersion: 2,
      }),
    ).resolves.toMatchObject({ id: kindId });

    for (const scope of [
      { appId: APP, agentFolder: FOLDER, actingPersonId: 'another-person' },
      { appId: 'another-app', agentFolder: FOLDER, actingPersonId: person },
      { appId: APP, agentFolder: 'another-folder', actingPersonId: person },
    ]) {
      await expect(
        repository.findHumanDecision({
          ...scope,
          candidates: [{ scope: 'exact', scopeKey: 'effect-find-exact' }],
          railVersion: 2,
        }),
      ).resolves.toBeNull();
    }

    const revokedId = '40000000-0000-4000-8000-000000000003';
    await put(revokedId, 'exact', 'effect-find-revoked');
    await repository.revokeById({
      appId: APP,
      agentFolder: FOLDER,
      actingPersonId: person,
      recordId: revokedId,
      nowIso: '2026-09-07T00:01:00.000Z',
    });
    await expect(
      repository.findHumanDecision({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        candidates: [{ scope: 'exact', scopeKey: 'effect-find-revoked' }],
        railVersion: 2,
      }),
    ).resolves.toBeNull();

    await put(
      '40000000-0000-4000-8000-000000000004',
      'exact',
      'effect-find-old-rails',
      { railVersion: 1 },
    );
    await expect(
      repository.findHumanDecision({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        candidates: [{ scope: 'exact', scopeKey: 'effect-find-old-rails' }],
        railVersion: 2,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findHumanDecision({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: person,
        candidates: [{ scope: 'exact', scopeKey: 'effect-not-found' }],
        railVersion: 2,
      }),
    ).resolves.toBeNull();
  });

  it("projects a row written for person A for A's job and not for B's job not after revocation and not from another rail version without writing memory", async () => {
    const repository = runtime.repositories.permissionDecisionMemory;
    const personA = 'person-job-projection-a';
    const recordId = '50000000-0000-4000-8000-000000000001';
    const request: PermissionApprovalRequest = {
      requestId: 'job-projection-request',
      appId: APP,
      sourceAgentFolder: FOLDER,
      toolName: 'WebRead',
      toolInput: { url: 'https://example.com/report' },
    };
    const effectHash = 'effect-job-projection';
    const putHumanDecision = vi.spyOn(repository, 'putHumanDecision');
    const service = new HumanDecisionMemoryService({
      repository,
      newId: () => recordId,
      now: () => '2026-09-08T00:00:00.000Z',
    });

    await expect(
      service.remember({
        appId: APP,
        agentFolder: FOLDER,
        actingPersonId: personA,
        resolution: { kind: 'remember', outcome: 'allow', scope: 'exact' },
        request,
        effectHash,
        workspaceRoot: '/workspace',
        railVersion: RAIL_CATALOG_VERSION,
        effectSchemaVersion: 3,
        reason: 'remembered for the owner',
      }),
    ).resolves.toMatchObject({ status: 'remembered', id: recordId });
    putHumanDecision.mockClear();

    const project = (ownerPersonId: string) =>
      projectHumanDecisionMatch({
        ownerPersonId,
        request,
        facts: { effectHash, workspaceRoot: '/workspace' },
        railVersion: RAIL_CATALOG_VERSION,
        memory: repository,
        warn: vi.fn(),
      });
    await expect(project(personA)).resolves.toEqual({
      recordId,
      scope: 'exact',
    });
    await expect(project('person-job-projection-b')).resolves.toBeNull();
    expect(putHumanDecision).not.toHaveBeenCalled();

    await service.revoke({
      appId: APP,
      agentFolder: FOLDER,
      actingPersonId: personA,
      recordId,
    });
    await expect(project(personA)).resolves.toBeNull();

    const oldRailRecordId = '50000000-0000-4000-8000-000000000002';
    await new HumanDecisionMemoryService({
      repository,
      newId: () => oldRailRecordId,
      now: () => '2026-09-08T00:02:00.000Z',
    }).remember({
      appId: APP,
      agentFolder: FOLDER,
      actingPersonId: personA,
      resolution: { kind: 'remember', outcome: 'allow', scope: 'exact' },
      request,
      effectHash,
      workspaceRoot: '/workspace',
      railVersion: RAIL_CATALOG_VERSION + 1,
      effectSchemaVersion: 3,
      reason: 'remembered under another rail version',
    });
    putHumanDecision.mockClear();
    await expect(project(personA)).resolves.toBeNull();
    expect(putHumanDecision).not.toHaveBeenCalled();
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
