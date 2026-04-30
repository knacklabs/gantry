import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inArray } from 'drizzle-orm';
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
    linked_sessions: ['app:control-repo'],
    session_id: null,
    thread_id: 'thread-control',
    group_scope: 'control-agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: false,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    execution_mode: 'serialized',
    ...patch,
  } satisfies JobUpsertInput;
}

maybeDescribe('PostgresControlPlaneRepository', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'control_repo',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('manages sessions, response routes, webhooks, deliveries, and triggers', async () => {
    const session = await runtime.control.ensureAppSession({
      appId: 'default',
      conversationId: 'conversation-control',
      chatJid: 'app:control-repo',
      groupFolder: 'control-agent',
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
});
