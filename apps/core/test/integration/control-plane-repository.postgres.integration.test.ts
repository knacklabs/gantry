import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { and, count, eq, inArray, like } from 'drizzle-orm';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const now = '2026-04-30T00:00:00.000Z';

function makeJob(id: string, patch: Partial<JobUpsertInput> = {}) {
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Check control-plane repository behavior',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: 'thread-control',
    execution_context: {
      conversationJid: 'conversation-control',
      threadId: 'thread-control',
      workspaceKey: 'control-agent',
      sessionId: null,
    },
    notification_routes: [
      {
        conversationJid: 'conversation-control',
        threadId: 'thread-control',
        label: 'Primary',
      },
    ],
    workspace_key: 'control-agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    ...patch,
  } satisfies JobUpsertInput;
}

maybeDescribe('PostgresControlPlaneRepository', () => {
  let runtime: PostgresIntegrationRuntime;
  const originalSecretEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'control_repo',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
    if (originalSecretEncryptionKey === undefined) {
      delete process.env.SECRET_ENCRYPTION_KEY;
    } else {
      process.env.SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
    }
  });

  it('manages sessions, response routes, webhooks, deliveries, and triggers', async () => {
    const session = await runtime.control.ensureAppSession({
      appId: 'default',
      conversationId: 'conversation-control',
      chatJid: 'app:control-repo',
      workspaceFolder: 'control-agent',
      title: 'Control Repo',
      defaultResponseMode: 'both',
    });

    await expect(
      runtime.control.getAppSessionById(session.sessionId),
    ).resolves.toMatchObject({ chatJid: 'app:control-repo' });
    await expect(
      runtime.control.getAppSessionByChatJid('app:control-repo'),
    ).resolves.toMatchObject({ sessionId: session.sessionId });
    await expect(
      runtime.control.getAppSessionsByChatJids([
        'app:control-repo',
        'app:missing',
        'app:control-repo',
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ sessionId: session.sessionId }),
    ]);

    await expect(
      runtime.control.upsertAppResponseRoute({
        sessionId: session.sessionId,
        threadId: 'thread-control',
        responseMode: 'webhook',
        webhookId: null,
        correlationId: 'corr-1',
      }),
    ).resolves.toMatchObject({ responseMode: 'webhook' });
    await expect(
      runtime.control.getAppResponseRoute({
        sessionId: session.sessionId,
        threadId: 'thread-control',
      }),
    ).resolves.toMatchObject({ correlationId: 'corr-1' });

    const webhook = await runtime.control.registerWebhook({
      webhookId: 'webhook:control-repo',
      appId: 'default',
      name: 'control-repo',
      url: 'https://example.test/webhook',
      secret: 'secret',
    });
    await expect(
      runtime.control.getWebhookById(webhook.webhookId, 'default'),
    ).resolves.toMatchObject({
      webhookId: webhook.webhookId,
      secret: 'secret',
    });
    await expect(runtime.control.listWebhooks('default')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'control-repo' }),
      ]),
    );
    await expect(
      runtime.control.updateWebhook(webhook.webhookId, 'default', {
        enabled: false,
      }),
    ).resolves.toMatchObject({ enabled: false });

    const event = await runtime.repositories.runtimeEvents.appendRuntimeEvent({
      appId: 'default' as never,
      sessionId: session.sessionId as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      actor: 'agent',
      responseMode: 'webhook',
      webhookId: webhook.webhookId,
      payload: { text: 'done' },
      createdAt: now as never,
    });
    await expect(runtime.control.listDueWebhookDeliveries(10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: event.eventId }),
      ]),
    );
    const claimed = await runtime.control.claimDueWebhookDeliveries(10);
    expect(claimed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: event.eventId,
          eventAppId: 'default',
          webhook: expect.objectContaining({ webhookId: webhook.webhookId }),
          event: expect.objectContaining({
            payload: JSON.stringify({ text: 'done' }),
          }),
        }),
      ]),
    );
    const deliveryId = claimed.find(
      (delivery) => delivery.eventId === event.eventId,
    )!.deliveryId;
    await runtime.control.markWebhookDeliveryRetry({
      deliveryId,
      nextAttemptAt: now,
      lastError: 'retry me',
    });
    await runtime.control.markWebhookDeliveryDead(deliveryId, 'dead letter');
    await expect(
      runtime.control.replayWebhookDeadLetters(webhook.webhookId, 'default'),
    ).resolves.toBe(1);
    await runtime.control.markWebhookDeliveryDead(deliveryId, 'dead again');
    await expect(
      runtime.control.purgeWebhookDeadLetters(webhook.webhookId, 'default'),
    ).resolves.toBe(1);

    const job = makeJob('job:control-repo');
    await runtime.ops.upsertJob(job);
    const trigger = await runtime.control.createJobTrigger({
      jobId: job.id,
      requestedBy: 'integration-test',
    });
    await runtime.ops.createJobRun({
      run_id: 'run:control-repo',
      job_id: job.id,
      execution_provider_id: 'anthropic:claude-agent-sdk',
      scheduled_for: now,
      started_at: now,
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    await expect(
      runtime.control.bindTriggerToRun(trigger.triggerId, 'run:control-repo'),
    ).resolves.toMatchObject({ status: 'claimed', runId: 'run:control-repo' });
    await runtime.control.markTriggerCompleted(trigger.triggerId, 'completed');
    await expect(
      runtime.control.getTriggerById(trigger.triggerId),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('claims due webhook deliveries without duplicate concurrent claims', async () => {
    const webhook = await runtime.control.registerWebhook({
      webhookId: 'webhook:control-repo-concurrent',
      appId: 'default',
      name: 'control-repo-concurrent',
      url: 'https://example.test/webhook-concurrent',
      secret: 'secret',
    });
    const events = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        runtime.repositories.runtimeEvents.appendRuntimeEvent({
          appId: 'default' as never,
          eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
          actor: 'agent',
          responseMode: 'webhook',
          webhookId: webhook.webhookId,
          payload: { index },
          createdAt: now as never,
        }),
      ),
    );

    const [first, second] = await Promise.all([
      runtime.control.claimDueWebhookDeliveries(3),
      runtime.control.claimDueWebhookDeliveries(3),
    ]);
    const claimed = [...first, ...second].filter((delivery) =>
      events.some((event) => event.eventId === delivery.eventId),
    );
    const deliveryIds = claimed.map((delivery) => delivery.deliveryId);
    expect(new Set(deliveryIds).size).toBe(deliveryIds.length);
    expect(claimed).toHaveLength(events.length);
    expect(claimed[0]).toMatchObject({
      eventAppId: 'default',
      webhook: expect.objectContaining({ webhookId: webhook.webhookId }),
      event: expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND,
      }),
    });

    const rows = await runtime.service.db
      .select()
      .from(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .where(
        inArray(
          pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
          deliveryIds,
        ),
      );
    expect(rows).toHaveLength(events.length);
    expect(rows.every((row) => row.status === 'delivering')).toBe(true);
    expect(rows.every((row) => row.attemptCount === 1)).toBe(true);
    expect(rows.every((row) => row.lastError === null)).toBe(true);
  });

  it('binds the oldest pending trigger and does not double-claim', async () => {
    const job = makeJob('job:control-repo-pending-bind');
    await runtime.ops.upsertJob(job);
    await runtime.service.db
      .insert(pgSchema.canonicalJobTriggersPostgres)
      .values([
        {
          id: 'trigger:control-repo-oldest',
          appId: 'default',
          jobId: job.id,
          runId: null,
          requestedBy: 'integration-test',
          requestedAt: '2026-04-30T00:00:01.000Z',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'trigger:control-repo-newest',
          appId: 'default',
          jobId: job.id,
          runId: null,
          requestedBy: 'integration-test',
          requestedAt: '2026-04-30T00:00:02.000Z',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
      ]);
    for (const runId of [
      'run:control-repo-oldest',
      'run:control-repo-newest',
      'run:control-repo-extra',
    ]) {
      await runtime.ops.createJobRun({
        run_id: runId,
        job_id: job.id,
        execution_provider_id: 'anthropic:claude-agent-sdk',
        scheduled_for: now,
        started_at: now,
        ended_at: null,
        status: 'running',
        result_summary: null,
        error_summary: null,
        retry_count: 0,
        notified_at: null,
      });
    }

    await expect(
      runtime.control.bindPendingTriggerToRun(
        job.id,
        'run:control-repo-oldest',
      ),
    ).resolves.toMatchObject({
      triggerId: 'trigger:control-repo-oldest',
      runId: 'run:control-repo-oldest',
      status: 'claimed',
    });

    const [first, second] = await Promise.all([
      runtime.control.bindPendingTriggerToRun(
        job.id,
        'run:control-repo-newest',
      ),
      runtime.control.bindPendingTriggerToRun(job.id, 'run:control-repo-extra'),
    ]);
    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      triggerId: 'trigger:control-repo-newest',
      status: 'claimed',
    });
  });

  it('persists external ingress records, replay state, scoped waits, and retention cleanup', async () => {
    const ingress = await runtime.control.createExternalIngress({
      ingressId: 'ingress:control-repo:a',
      appId: 'default',
      name: 'scraper-a',
      secret: 'secret-a',
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['session_message'],
          conversationIds: ['conversation-control'],
        },
      },
    });
    await runtime.control.createExternalIngress({
      ingressId: 'ingress:control-repo:b',
      appId: 'default',
      name: 'scraper-b',
      secret: 'secret-b',
      metadata: {
        targetPolicy: {
          allowedTargetKinds: ['job_trigger'],
          jobIds: ['job:control-repo'],
        },
      },
    });

    await expect(
      runtime.control.listExternalIngresses('default'),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ingressId: ingress.ingressId,
          metadata: expect.objectContaining({
            targetPolicy: expect.objectContaining({
              allowedTargetKinds: ['session_message'],
            }),
          }),
        }),
      ]),
    );
    await expect(
      runtime.control.getExternalIngressById(ingress.ingressId, 'default'),
    ).resolves.toMatchObject({
      name: 'scraper-a',
      enabled: true,
      secret: 'secret-a',
    });
    await expect(
      runtime.control.updateExternalIngress(ingress.ingressId, 'default', {
        enabled: false,
      }),
    ).resolves.toMatchObject({ enabled: false });
    await runtime.service.db.insert(pgSchema.externalIngressesPostgres).values({
      ingressId: 'ingress:control-repo:plaintext',
      appId: 'default',
      name: 'plaintext-rotatable',
      secret: 'plaintext-secret',
      enabled: true,
      metadataJson: '{}',
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      runtime.control.getExternalIngressById(
        'ingress:control-repo:plaintext',
        'default',
      ),
    ).rejects.toThrow('not encrypted');
    await expect(
      runtime.control.updateExternalIngress(
        'ingress:control-repo:plaintext',
        'default',
        { secret: 'rotated-secret' },
      ),
    ).resolves.toMatchObject({ secret: 'rotated-secret' });

    await expect(
      runtime.control.reserveExternalIngressNonce({
        appId: 'default',
        ingressId: ingress.ingressId,
        nonce: 'nonce-control-repo',
        now,
        expiresAt: '2026-04-30T00:05:00.000Z',
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      runtime.control.reserveExternalIngressNonce({
        appId: 'default',
        ingressId: ingress.ingressId,
        nonce: 'nonce-control-repo',
        now,
        expiresAt: '2026-04-30T00:05:00.000Z',
      }),
    ).resolves.toEqual({ ok: false, code: 'NONCE_REPLAY' });

    const created = await runtime.control.createExternalIngressInvocation({
      invocationId: 'invocation:control-repo:a',
      appId: 'default',
      ingressId: ingress.ingressId,
      idempotencyKey: 'idem-control-repo',
      nonce: 'nonce-control-repo',
      requestMethod: 'POST',
      requestPath: `/v1/ingresses/${ingress.ingressId}/invoke`,
      requestTimestamp: now,
      bodyHash: 'hash',
      requestBody: '{"target":{"kind":"session_message"}}',
      signature: 'signature',
      status: 'pending',
      now,
      expiresAt: '2026-05-30T00:00:00.000Z',
    });
    expect(created).toEqual({
      created: true,
      row: {
        invocationId: 'invocation:control-repo:a',
        status: 'pending',
        bodyHash: 'hash',
        response: null,
        error: null,
        updatedAt: expect.any(String),
      },
    });
    await expect(
      runtime.control.createExternalIngressInvocation({
        invocationId: 'invocation:control-repo:duplicate',
        appId: 'default',
        ingressId: ingress.ingressId,
        idempotencyKey: 'idem-control-repo',
        nonce: 'nonce-control-repo-duplicate',
        requestMethod: 'POST',
        requestPath: `/v1/ingresses/${ingress.ingressId}/invoke`,
        requestTimestamp: now,
        bodyHash: 'hash',
        requestBody: '{}',
        signature: 'signature',
        status: 'pending',
        now,
        expiresAt: '2026-05-30T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      created: false,
      row: {
        invocationId: 'invocation:control-repo:a',
        status: 'pending',
        bodyHash: 'hash',
        response: null,
        error: null,
        updatedAt: expect.any(String),
      },
    });
    await expect(
      runtime.control.createExternalIngressInvocation({
        invocationId: 'invocation:control-repo:exact-retry',
        appId: 'default',
        ingressId: ingress.ingressId,
        idempotencyKey: 'idem-control-repo',
        nonce: 'nonce-control-repo',
        requestMethod: 'POST',
        requestPath: `/v1/ingresses/${ingress.ingressId}/invoke`,
        requestTimestamp: now,
        bodyHash: 'hash',
        requestBody: '{"target":{"kind":"session_message"}}',
        signature: 'signature',
        status: 'pending',
        now,
        expiresAt: '2026-05-30T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      created: false,
      row: {
        invocationId: 'invocation:control-repo:a',
        status: 'pending',
        bodyHash: 'hash',
        response: null,
        error: null,
        updatedAt: expect.any(String),
      },
    });

    await runtime.control.updateExternalIngressInvocation({
      invocationId: 'invocation:control-repo:a',
      status: 'completed',
      response: { ok: true },
      now: '2026-04-30T00:00:01.000Z',
    });
    await expect(
      runtime.control.createExternalIngressInvocation({
        invocationId: 'invocation:control-repo:completed-duplicate',
        appId: 'default',
        ingressId: ingress.ingressId,
        idempotencyKey: 'idem-control-repo',
        nonce: 'nonce-control-repo-completed',
        requestMethod: 'POST',
        requestPath: `/v1/ingresses/${ingress.ingressId}/invoke`,
        requestTimestamp: now,
        bodyHash: 'hash',
        requestBody: '{}',
        signature: 'signature',
        status: 'pending',
        now,
        expiresAt: '2026-05-30T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      created: false,
      row: {
        invocationId: 'invocation:control-repo:a',
        status: 'completed',
        bodyHash: 'hash',
        response: { ok: true },
        error: null,
        updatedAt: expect.any(String),
      },
    });
    await expect(
      runtime.control.getExternalIngressInvocation(
        'invocation:control-repo:a',
        'default',
        ingress.ingressId,
      ),
    ).resolves.toMatchObject({
      invocationId: 'invocation:control-repo:a',
      status: 'completed',
      response: { ok: true },
    });
    await expect(
      runtime.control.getExternalIngressInvocation(
        'invocation:control-repo:a',
        'default',
        'ingress:control-repo:b',
      ),
    ).resolves.toBeUndefined();

    const stalePendingRecoveryCap = 1000;
    const deleteBatchSize = 1000;
    const deleteBatchCapPerSweep = 10;
    const expiredDeleteCap = deleteBatchSize * deleteBatchCapPerSweep;
    const stalePendingRows = Array.from(
      { length: stalePendingRecoveryCap + 1 },
      (_, index) => ({
        invocationId: `invocation:control-repo:stale:${index}`,
        appId: 'default',
        ingressId: ingress.ingressId,
        idempotencyKey: `idem-stale-control-repo:${index}`,
        nonce: `nonce-stale-control-repo:${index}`,
        requestMethod: 'POST',
        requestPath: `/v1/ingresses/${ingress.ingressId}/invoke`,
        requestTimestamp: now,
        bodyHash: 'hash',
        requestBody: '{}',
        signature: 'signature',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        expiresAt: '2026-05-30T00:00:00.000Z',
      }),
    );
    const expiredInvocationRows = Array.from(
      { length: expiredDeleteCap + 1 },
      (_, index) => ({
        invocationId: `invocation:control-repo:expired-bulk:${index}`,
        appId: 'default',
        ingressId: ingress.ingressId,
        idempotencyKey: `idem-expired-control-repo:${index}`,
        nonce: `nonce-expired-control-repo:${index}`,
        requestMethod: 'POST',
        requestPath: `/v1/ingresses/${ingress.ingressId}/invoke`,
        requestTimestamp: now,
        bodyHash: 'hash',
        requestBody: '{}',
        signature: 'signature',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
        expiresAt: '2026-04-29T00:00:00.000Z',
      }),
    );
    const expiredNonceRows = Array.from(
      { length: expiredDeleteCap + 1 },
      (_, index) => ({
        appId: 'default',
        ingressId: ingress.ingressId,
        nonce: `nonce-expired-control-repo-bulk:${index}`,
        createdAt: now,
        expiresAt: '2026-04-29T00:00:00.000Z',
      }),
    );
    await insertInChunks(stalePendingRows, 250, async (chunk) => {
      await runtime.service.db
        .insert(pgSchema.externalIngressInvocationsPostgres)
        .values(chunk);
    });
    await insertInChunks(expiredInvocationRows, 250, async (chunk) => {
      await runtime.service.db
        .insert(pgSchema.externalIngressInvocationsPostgres)
        .values(chunk);
    });
    await insertInChunks(expiredNonceRows, 500, async (chunk) => {
      await runtime.service.db
        .insert(pgSchema.externalIngressNoncesPostgres)
        .values(chunk);
    });
    const sweep = await runtime.control.sweepExpiredExternalIngressState({
      now: '2026-04-30T00:06:00.000Z',
    });
    expect(sweep).toMatchObject({
      stalePendingFailed: stalePendingRecoveryCap,
      noncesDeleted: expiredDeleteCap,
      invocationsDeleted: expiredDeleteCap,
    });
    await expect(
      countExternalIngressRows({
        runtime,
        table: 'invocations',
        idLike: 'invocation:control-repo:stale:%',
        status: 'pending',
      }),
    ).resolves.toBe(1);
    const remainingExpiredBulkInvocations = await countExternalIngressRows({
      runtime,
      table: 'invocations',
      idLike: 'invocation:control-repo:expired-bulk:%',
    });
    expect(remainingExpiredBulkInvocations).toBeGreaterThan(0);
    expect(remainingExpiredBulkInvocations).toBeLessThanOrEqual(2);
    const remainingExpiredBulkNonces = await countExternalIngressRows({
      runtime,
      table: 'nonces',
      idLike: 'nonce-expired-control-repo-bulk:%',
    });
    expect(remainingExpiredBulkNonces).toBeGreaterThan(0);
    expect(remainingExpiredBulkNonces).toBeLessThanOrEqual(2);
  });
});

async function insertInChunks<T>(
  rows: T[],
  chunkSize: number,
  writeChunk: (chunk: T[]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += chunkSize) {
    await writeChunk(rows.slice(start, start + chunkSize));
  }
}

async function countExternalIngressRows(input: {
  runtime: PostgresIntegrationRuntime;
  table: 'invocations' | 'nonces';
  idLike: string;
  status?: string;
}): Promise<number> {
  if (input.table === 'nonces') {
    const rows = await input.runtime.service.db
      .select({ value: count() })
      .from(pgSchema.externalIngressNoncesPostgres)
      .where(like(pgSchema.externalIngressNoncesPostgres.nonce, input.idLike));
    return rows[0]?.value ?? 0;
  }
  const conditions = [
    like(
      pgSchema.externalIngressInvocationsPostgres.invocationId,
      input.idLike,
    ),
  ];
  if (input.status) {
    conditions.push(
      eq(pgSchema.externalIngressInvocationsPostgres.status, input.status),
    );
  }
  const rows = await input.runtime.service.db
    .select({ value: count() })
    .from(pgSchema.externalIngressInvocationsPostgres)
    .where(and(...conditions));
  return rows[0]?.value ?? 0;
}
