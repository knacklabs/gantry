import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_CONFIG_VERSION_ID,
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('Postgres runtime-event metrics and retention', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'runtime_event_metrics',
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('aggregates bounded metrics and protects runtime-event delivery evidence at retention cutoff', async () => {
    const append = runtime.repositories.runtimeEvents.appendRuntimeEvent.bind(
      runtime.repositories.runtimeEvents,
    );
    for (let index = 0; index < 6; index += 1) {
      await append({
        appId: DEFAULT_APP_ID as never,
        eventType: RUNTIME_EVENT_TYPES.MODEL_USAGE,
        actor: 'test',
        payload: {
          usage: {
            inputTokens: 10 + index,
            outputTokens: index,
            cacheReadTokens: index,
            cacheWriteTokens: index + 1,
            ...(index === 0 ? { estimatedCostUsd: 0.25 } : {}),
          },
          modelAlias: `model-${index}`,
        },
        createdAt: `2026-08-12T0${index}:00:00.000Z` as never,
      });
    }
    for (const run of [
      { id: 'run:metrics-completed', status: 'completed', duration: 1_000 },
      { id: 'run:metrics-failed', status: 'failed', duration: 2_000 },
    ] as const) {
      const startedAt = Date.parse('2026-08-12T06:00:00.000Z');
      await runtime.repositories.agentRuns.saveAgentRun({
        id: run.id as never,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        configVersionId: DEFAULT_AGENT_CONFIG_VERSION_ID as never,
        llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
        executionProviderId: 'execution-provider:test' as never,
        permissionDecisionIds: [],
        cause: 'message',
        status: run.status,
        createdAt: new Date(startedAt).toISOString() as never,
        startedAt: new Date(startedAt).toISOString() as never,
        endedAt: new Date(startedAt + run.duration).toISOString() as never,
      });
    }

    const metrics =
      await runtime.repositories.runtimeEvents.queryConsoleMetrics({
        appId: DEFAULT_APP_ID as never,
        from: '2026-08-12T00:00:00.000Z' as never,
        to: '2026-08-13T00:00:00.000Z' as never,
        bucket: 'hour',
      });
    expect(metrics.usage.totals).toEqual({
      requestCount: 6,
      inputTokens: 75,
      outputTokens: 15,
      cacheReadTokens: 15,
      cacheWriteTokens: 21,
      estimatedCostUsd: 0.25,
    });
    expect(metrics.usage.buckets).toHaveLength(6);
    expect(metrics.usage.models).toHaveLength(6);
    expect(metrics.usage.models.at(-1)).toMatchObject({
      model: 'Other',
      requestCount: 1,
    });
    expect(metrics.runs).toMatchObject({
      total: 2,
      statuses: [
        { status: 'completed', count: 1 },
        { status: 'failed', count: 1 },
      ],
      p95DurationMs: 1950,
    });

    const cutoff = '2026-07-13T12:00:00.000Z';
    const old = await append({
      appId: DEFAULT_APP_ID as never,
      eventType: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
      actor: 'test',
      payload: {},
      createdAt: '2026-07-13T11:59:59.000Z' as never,
    });
    const boundary = await append({
      appId: DEFAULT_APP_ID as never,
      eventType: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
      actor: 'test',
      payload: {},
      createdAt: cutoff as never,
    });
    const pendingOutbox = await append({
      appId: DEFAULT_APP_ID as never,
      eventType: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
      actor: 'test',
      payload: {},
      createdAt: '2026-07-01T00:00:00.000Z' as never,
    });
    const retryableOutbox = await append({
      appId: DEFAULT_APP_ID as never,
      eventType: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
      actor: 'test',
      payload: {},
      createdAt: '2026-07-01T00:00:00.500Z' as never,
    });
    const webhook = await runtime.control.registerWebhook({
      webhookId: 'webhook:runtime-event-retention',
      appId: DEFAULT_APP_ID,
      name: 'runtime-event-retention',
      url: 'https://example.test/runtime-event-retention',
      secret: 'secret',
      eventTypes: [RUNTIME_EVENT_TYPES.WEBHOOK_TEST],
    });
    const pendingWebhook = await append({
      appId: DEFAULT_APP_ID as never,
      eventType: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
      actor: 'test',
      responseMode: 'webhook',
      webhookId: webhook.webhookId,
      payload: {},
      createdAt: '2026-07-01T00:00:01.000Z' as never,
    });
    await runtime.service.pool.query(
      `DELETE FROM event_bus_outbox WHERE runtime_event_id = ANY($1::int[])`,
      [[old.eventId, boundary.eventId, pendingWebhook.eventId]],
    );
    await runtime.service.pool.query(
      `UPDATE event_bus_outbox SET status = 'failed'
       WHERE runtime_event_id = $1`,
      [retryableOutbox.eventId],
    );
    await runtime.service.pool.query(
      `UPDATE control_http_webhook_deliveries SET status = 'delivering'
       WHERE event_id = $1`,
      [pendingWebhook.eventId],
    );
    await runtime.service.pool.query(
      `INSERT INTO runtime_events (app_id, event_type, actor, payload_json, created_at)
       SELECT $1, $2, 'test', '{}', $3::timestamptz
       FROM generate_series(1, 499)`,
      [
        DEFAULT_APP_ID,
        RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
        '2026-07-01T00:00:02.000Z',
      ],
    );

    let result =
      await runtime.repositories.runtimeEvents.deleteExpiredRuntimeEvents(
        cutoff,
      );
    expect(result).toEqual({ deleted: 500, more: true });
    do {
      result =
        await runtime.repositories.runtimeEvents.deleteExpiredRuntimeEvents(
          cutoff,
        );
      expect(result.deleted).toBeLessThanOrEqual(500);
    } while (result.more);

    const preserved = await runtime.service.pool.query<{ event_id: number }>(
      `SELECT event_id FROM runtime_events WHERE event_id = ANY($1::int[])`,
      [
        [
          boundary.eventId,
          pendingOutbox.eventId,
          retryableOutbox.eventId,
          pendingWebhook.eventId,
        ],
      ],
    );
    expect(
      preserved.rows.map((row) => row.event_id).sort((a, b) => a - b),
    ).toEqual(
      [
        boundary.eventId,
        pendingOutbox.eventId,
        retryableOutbox.eventId,
        pendingWebhook.eventId,
      ].sort((a, b) => a - b),
    );
    await expect(
      runtime.service.pool.query(
        `SELECT 1 FROM runtime_events WHERE event_id = $1`,
        [old.eventId],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  }, 60_000);
});
