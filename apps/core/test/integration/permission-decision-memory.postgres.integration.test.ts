import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { permissionDecisionMemoryPostgres } from '@core/adapters/storage/postgres/schema/schema.js';
import { AllowOnceNeverPersistedError } from '@core/domain/ports/permission-decision-memory.js';

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

  it('round-trips a classifier verdict by effect hash', async () => {
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

  it('enforces the (app, folder, kind, lookup_identity) unique constraint', async () => {
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
