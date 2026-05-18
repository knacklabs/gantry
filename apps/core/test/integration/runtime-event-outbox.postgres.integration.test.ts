import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';
import type { AppId } from '@core/domain/app/app.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { JobId } from '@core/domain/jobs/jobs.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('Postgres runtime event outbox', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'runtime_event_outbox',
    });
  }, 60_000);

  afterAll(async () => {
    if (!runtime) return;
    await runtime.cleanup();
  });

  it('persists a canonical event-bus outbox row with appended runtime events', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const jobId = 'job:test:runtime-event-outbox' as JobId;
    const createdAt = '2026-05-12T10:00:00.000Z';

    const event = await runtime.repositories.runtimeEvents.appendRuntimeEvent({
      appId,
      jobId,
      eventType: RUNTIME_EVENT_TYPES.JOB_STARTED,
      actor: 'scheduler',
      correlationId: 'corr:test:runtime-event-outbox',
      responseMode: 'none',
      payload: {
        jobId,
        status: 'running',
      },
      createdAt,
    });

    const { rows } = await runtime.service.pool.query<{
      id: string;
      eventType: string;
      eventVersion: number;
      source: string;
      appId: string;
      runtimeEventId: number;
      correlationId: string | null;
      payloadJson: string;
      occurredAt: string;
      status: string;
      attemptCount: number;
      publishedAt: Date | null;
    }>(
      `SELECT
        id,
        event_type AS "eventType",
        event_version AS "eventVersion",
        source,
        app_id AS "appId",
        runtime_event_id AS "runtimeEventId",
        correlation_id AS "correlationId",
        payload_json AS "payloadJson",
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
        status,
        attempt_count AS "attemptCount",
        published_at AS "publishedAt"
      FROM event_bus_outbox
      WHERE runtime_event_id = $1`,
      [event.eventId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: RUNTIME_EVENT_TYPES.JOB_STARTED,
      eventVersion: 1,
      source: 'gantry.runtime_events',
      appId,
      runtimeEventId: event.eventId,
      correlationId: 'corr:test:runtime-event-outbox',
      occurredAt: createdAt,
      status: 'pending',
      attemptCount: 0,
      publishedAt: null,
    });

    const envelope = JSON.parse(rows[0]!.payloadJson) as {
      runtimeEvent: Record<string, unknown>;
    };
    expect(envelope.runtimeEvent).toMatchObject({
      eventId: event.eventId,
      appId,
      jobId,
      eventType: RUNTIME_EVENT_TYPES.JOB_STARTED,
      actor: 'scheduler',
      correlationId: 'corr:test:runtime-event-outbox',
      responseMode: 'none',
      createdAt,
      payload: {
        jobId,
        status: 'running',
      },
    });

    await expect(
      runtime.repositories.runtimeEvents.listRuntimeEvents({
        appId,
        jobId,
        eventTypes: [RUNTIME_EVENT_TYPES.JOB_STARTED],
      }),
    ).resolves.toMatchObject([{ eventId: event.eventId }]);
  });

  it('replays durable runtime events by cursor without relying on NOTIFY wakeups', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const jobId = 'job:test:runtime-event-replay' as JobId;

    const first = await runtime.repositories.runtimeEvents.appendRuntimeEvent({
      appId,
      jobId,
      eventType: RUNTIME_EVENT_TYPES.JOB_STARTED,
      actor: 'scheduler',
      responseMode: 'none',
      payload: { jobId, step: 'before-cursor' },
    });
    const missedWakeup =
      await runtime.repositories.runtimeEvents.appendRuntimeEvent({
        appId,
        jobId,
        eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
        actor: 'scheduler',
        responseMode: 'none',
        payload: { jobId, step: 'missed-wakeup' },
      });

    await expect(
      runtime.repositories.runtimeEvents.listRuntimeEvents({
        appId,
        jobId,
        afterEventId: first.eventId,
      }),
    ).resolves.toMatchObject([
      {
        eventId: missedWakeup.eventId,
        eventType: RUNTIME_EVENT_TYPES.JOB_COMPLETED,
        payload: { jobId, step: 'missed-wakeup' },
      },
    ]);
  });
});
