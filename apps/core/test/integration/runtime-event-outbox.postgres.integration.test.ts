import { createHmac } from 'node:crypto';
import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import type { AppId } from '@core/domain/app/app.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { JobId } from '@core/domain/jobs/jobs.js';
import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import { flushWebhookDeliveries } from '@core/control/server/webhook-delivery.js';
import { recordPendingInteractionRequested } from '@core/application/interactions/pending-interaction-durability.js';
import { publishPendingInteractionRuntimeEvent } from '@core/runtime/ipc-interaction-processing.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import {
  collectObservedIndexes,
  collectPlanNodeTypes,
  collectScanNodes,
  normalizeExplainPayload,
  planNumber,
} from '../harness/postgres-explain.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const RUNTIME_EVENT_REPLAY_RUN_ID = 'runtime-event-replay-explain-itest';
const RUNTIME_EVENT_SEED_COUNT = 1_000_000;
const RUNTIME_EVENT_REPLAY_LIMIT = 25;
const EVENT_BUS_OUTBOX_CLAIM_RUN_ID = 'event-bus-outbox-claim-explain-itest';
const EVENT_BUS_OUTBOX_SEED_COUNT = 1_000_000;
const EVENT_BUS_OUTBOX_CLAIM_LIMIT = 25;
const ROWS_SCANNED_TO_RETURNED_RATIO_GATE = 20;

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

  it('fans out filtered lifecycle webhooks, emits pending interactions, settles outbox rows, and preserves dead letters', async () => {
    _setRuntimeStorageForTest(runtime.storageRuntime);
    process.env.GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS = 'true';
    process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS = 'true';
    const secret = 'lifecycle-webhook-secret';
    const received: Array<{
      body: string;
      eventType: string;
      signature: string;
      timestamp: string;
    }> = [];
    const receiver = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const eventType = String(request.headers['x-gantry-webhook-event']);
        received.push({
          body,
          eventType,
          signature: String(request.headers['x-gantry-webhook-signature']),
          timestamp: String(request.headers['x-gantry-webhook-timestamp']),
        });
        response.statusCode =
          eventType === RUNTIME_EVENT_TYPES.WEBHOOK_TEST ? 400 : 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, '127.0.0.1', resolve),
    );
    const address = receiver.address();
    if (!address || typeof address === 'string') {
      throw new Error('Lifecycle webhook receiver did not bind');
    }

    const appId = DEFAULT_APP_ID as AppId;
    const agentId = DEFAULT_AGENT_ID;
    const jobId = 'job:lifecycle-webhook';
    const conversationId = 'conversation:app:lifecycle-webhook';
    const threadId = 'thread:app:lifecycle-webhook:topic';
    const webhook = await runtime.control.registerWebhook({
      webhookId: 'webhook:lifecycle-filtered',
      appId,
      name: 'lifecycle-filtered',
      url: `http://127.0.0.1:${address.port}/events`,
      secret,
      eventTypes: [
        RUNTIME_EVENT_TYPES.RUN_COMPLETED,
        RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
      ],
      jobId,
    });

    try {
      await runtime.service.pool.query(
        `INSERT INTO conversations (
           id, app_id, provider_account_id, external_ref_json, kind, title,
           status, created_at, updated_at
         ) VALUES ($1, $2, 'provider:test', '{}', 'group', 'Lifecycle',
           'active', now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [conversationId, appId],
      );
      await runtime.service.pool.query(
        `INSERT INTO conversation_threads (
           id, app_id, conversation_id, external_ref_json, title, status,
           created_at, updated_at
         ) VALUES ($1, $2, $3, '{}', 'Lifecycle topic', 'active', now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [threadId, appId, conversationId],
      );

      await runtime.storageRuntime.runtimeEvents.publish({
        appId,
        agentId: agentId as never,
        jobId: jobId as never,
        conversationId: conversationId as never,
        threadId: threadId as never,
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
        actor: 'runtime',
        payload: { status: 'running' },
      });
      const completed = await runtime.storageRuntime.runtimeEvents.publish({
        appId,
        agentId: agentId as never,
        jobId: jobId as never,
        conversationId: conversationId as never,
        threadId: threadId as never,
        eventType: RUNTIME_EVENT_TYPES.RUN_COMPLETED,
        actor: 'runtime',
        payload: { status: 'completed' },
      });
      await expect(
        recordPendingInteractionRequested({
          kind: 'question',
          sourceAgentFolder: 'main_agent',
          requestId: 'question:lifecycle-webhook',
          appId,
          payload: { questions: ['Continue?'] },
        }),
      ).resolves.toBe(true);
      await publishPendingInteractionRuntimeEvent(
        {
          publishRuntimeEvent: (event) =>
            runtime.storageRuntime.runtimeEvents
              .publish(event)
              .then(() => undefined),
        } as never,
        {
          requestId: 'question:lifecycle-webhook',
          appId,
          agentId,
          jobId,
          targetJid: conversationId,
          threadId,
          questions: [],
        } as never,
        'question',
        'main_agent',
      );
      await runtime.storageRuntime.runtimeEvents.publish({
        appId,
        eventType: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
        actor: 'sdk',
        responseMode: 'webhook',
        webhookId: webhook.webhookId,
        payload: { ok: true },
      });

      await flushWebhookDeliveries();

      expect(received.map((delivery) => delivery.eventType).sort()).toEqual(
        [
          RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
          RUNTIME_EVENT_TYPES.RUN_COMPLETED,
          RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
        ].sort(),
      );
      expect(received).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
          }),
        ]),
      );
      for (const delivery of received) {
        const envelope = JSON.parse(delivery.body) as Record<string, unknown>;
        expect(delivery.signature).toBe(
          createHmac('sha256', secret)
            .update(
              `${delivery.timestamp}.${envelope.eventId}.${delivery.eventType}.${delivery.body}`,
            )
            .digest('hex'),
        );
      }
      expect(
        JSON.parse(
          received.find(
            (delivery) =>
              delivery.eventType === RUNTIME_EVENT_TYPES.RUN_COMPLETED,
          )!.body,
        ),
      ).toMatchObject({
        eventId: completed.eventId,
        agentId,
        conversationId,
        threadId,
        payload: { status: 'completed' },
      });

      const outbox = await runtime.service.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM event_bus_outbox',
      );
      expect(Number(outbox.rows[0]?.count ?? -1)).toBe(0);
      const deliveries = await runtime.service.pool.query<{
        event_type: string;
        status: string;
      }>(
        `SELECT event.event_type, delivery.status
         FROM control_http_webhook_deliveries AS delivery
         JOIN runtime_events AS event ON event.event_id = delivery.event_id
         WHERE delivery.webhook_id = $1`,
        [webhook.webhookId],
      );
      expect(deliveries.rows).toEqual(
        expect.arrayContaining([
          {
            event_type: RUNTIME_EVENT_TYPES.RUN_COMPLETED,
            status: 'delivered',
          },
          {
            event_type: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
            status: 'delivered',
          },
          {
            event_type: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
            status: 'dead_lettered',
          },
        ]),
      );
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      delete process.env.GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS;
      delete process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS;
    }
  });

  it('writes runtime event replay EXPLAIN evidence at row volume', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const otherAppId = 'app:test:runtime-event-replay-other';
    const runId = 'agent-run:test:runtime-event-replay';
    const sessionId = 'agent-session:test:runtime-event-replay';
    const jobId = 'job:test:runtime-event-replay-explain';
    const conversationId = 'conversation:test:runtime-event-replay';
    const threadId = 'thread:test:runtime-event-replay';
    const createdAt = '2026-06-17T00:00:00.000Z';
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('runtime_events')}`;

    await runtime.service.pool.query(
      `INSERT INTO apps (id, slug, name, status, created_at, updated_at)
         VALUES ($1, 'runtime-event-replay-other', 'Runtime Event Replay Other', 'active', $2, $2)
         ON CONFLICT (id) DO NOTHING`,
      [otherAppId, createdAt],
    );
    await runtime.service.pool.query(
      `INSERT INTO conversations (id, app_id, provider_account_id, external_ref_json, kind, title, status, created_at, updated_at)
         VALUES ($1, $2, 'provider:test', '{}', 'group', 'Runtime Event Replay', 'active', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
      [conversationId, appId, createdAt],
    );
    await runtime.service.pool.query(
      `INSERT INTO conversation_threads (id, app_id, conversation_id, external_ref_json, title, status, created_at, updated_at)
         VALUES ($1, $2, $3, '{}', 'Runtime Event Replay Thread', 'active', $4, $4)
         ON CONFLICT (id) DO NOTHING`,
      [threadId, appId, conversationId, createdAt],
    );
    await runtime.service.pool.query(
      `INSERT INTO agent_sessions (id, app_id, agent_id, conversation_id, thread_id, scope_key, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'runtime-event-replay', 'active', $6, $6)
         ON CONFLICT (id) DO NOTHING`,
      [sessionId, appId, DEFAULT_AGENT_ID, conversationId, threadId, createdAt],
    );
    await runtime.service.pool.query(
      `INSERT INTO agent_runs (
           id, app_id, agent_id, config_version_id, session_id, conversation_id,
           thread_id, job_id, llm_profile_id, execution_provider_id,
           permission_decision_ids_json, cause, status, created_at, started_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'test:runtime-events', '[]', 'message', 'completed', $10, $10)
         ON CONFLICT (id) DO NOTHING`,
      [
        runId,
        appId,
        DEFAULT_AGENT_ID,
        `config:${DEFAULT_AGENT_ID}:1`,
        sessionId,
        conversationId,
        threadId,
        jobId,
        DEFAULT_LLM_PROFILE_ID,
        createdAt,
      ],
    );

    await runtime.service.pool.query(
      `INSERT INTO runtime_events (
           app_id, agent_id, session_id, run_id, job_id, conversation_id,
           thread_id, event_type, actor, response_mode, payload_json, created_at
         )
         SELECT
           CASE WHEN n % 100 = 0 THEN $2 ELSE $12 END,
           CASE WHEN n % 100 = 0 THEN $3 ELSE NULL END,
           CASE WHEN n % 100 = 0 THEN $4 ELSE NULL END,
           CASE WHEN n % 100 = 0 THEN $5 ELSE NULL END,
           CASE WHEN n % 100 = 0 THEN $6 ELSE NULL END,
           CASE WHEN n % 100 = 0 THEN $7 ELSE NULL END,
           CASE WHEN n % 100 = 0 THEN $8 ELSE NULL END,
           CASE WHEN n % 50 = 0 THEN $9 ELSE $10 END,
           'runtime',
           'none',
           '{}',
           $11::timestamptz + (n || ' milliseconds')::interval
         FROM generate_series(1, $1::integer) AS series(n)`,
      [
        RUNTIME_EVENT_SEED_COUNT,
        appId,
        DEFAULT_AGENT_ID,
        sessionId,
        runId,
        jobId,
        conversationId,
        threadId,
        RUNTIME_EVENT_TYPES.JOB_STARTED,
        RUNTIME_EVENT_TYPES.JOB_COMPLETED,
        createdAt,
        otherAppId,
      ],
    );
    await runtime.service.pool.query(`ANALYZE ${tableName}`);

    const cardinality = Number(
      (
        await runtime.service.pool.query<{ count: number | string }>(
          `SELECT COUNT(*)::int AS count FROM ${tableName}`,
        )
      ).rows[0]?.count ?? 0,
    );
    const afterEventId = Number(
      (
        await runtime.service.pool.query<{ after_event_id: number | string }>(
          `SELECT (MAX(event_id) - 50000)::int AS after_event_id FROM ${tableName}`,
        )
      ).rows[0]?.after_event_id ?? 0,
    );

    const cases = [
      {
        name: 'app_cursor',
        expectedIndex: 'idx_runtime_events_app_cursor',
        sql: `SELECT * FROM ${tableName} WHERE app_id = $1 AND event_id > $2 ORDER BY event_id ASC LIMIT $3`,
        values: [appId, afterEventId, RUNTIME_EVENT_REPLAY_LIMIT],
      },
      {
        name: 'run_cursor',
        expectedIndex: 'idx_runtime_events_run_cursor',
        sql: `SELECT * FROM ${tableName} WHERE app_id = $1 AND event_id > $2 AND run_id = $4 ORDER BY event_id ASC LIMIT $3`,
        values: [appId, afterEventId, RUNTIME_EVENT_REPLAY_LIMIT, runId],
      },
      {
        name: 'job_cursor',
        expectedIndex: 'idx_runtime_events_job_cursor',
        sql: `SELECT * FROM ${tableName} WHERE app_id = $1 AND event_id > $2 AND job_id = $4 ORDER BY event_id ASC LIMIT $3`,
        values: [appId, afterEventId, RUNTIME_EVENT_REPLAY_LIMIT, jobId],
      },
      {
        name: 'session_cursor',
        expectedIndex: 'idx_runtime_events_session_cursor',
        sql: `SELECT * FROM ${tableName} WHERE app_id = $1 AND event_id > $2 AND session_id = $4 ORDER BY event_id ASC LIMIT $3`,
        values: [appId, afterEventId, RUNTIME_EVENT_REPLAY_LIMIT, sessionId],
      },
      {
        name: 'conversation_thread_cursor',
        expectedIndex: 'idx_runtime_events_conversation_thread_cursor',
        sql: `SELECT * FROM ${tableName} WHERE app_id = $1 AND event_id > $2 AND conversation_id = $4 AND thread_id = $5 ORDER BY event_id ASC LIMIT $3`,
        values: [
          appId,
          afterEventId,
          RUNTIME_EVENT_REPLAY_LIMIT,
          conversationId,
          threadId,
        ],
      },
      {
        name: 'event_type_cursor',
        expectedIndex: 'idx_runtime_events_type_cursor',
        sql: `SELECT * FROM ${tableName} WHERE app_id = $1 AND event_id > $2 AND event_type = $4 ORDER BY event_id ASC LIMIT $3`,
        values: [
          appId,
          afterEventId,
          RUNTIME_EVENT_REPLAY_LIMIT,
          RUNTIME_EVENT_TYPES.JOB_STARTED,
        ],
      },
    ];

    const plans = [];
    for (const item of cases) {
      const explain = await runtime.service.pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
        item.values,
      );
      const root = normalizeExplainPayload(explain.rows[0]?.['QUERY PLAN']);
      const scans = collectScanNodes(root.Plan);
      const actualRows = planNumber(root.Plan, 'Actual Rows') ?? 0;
      const scannedRows = scans.reduce(
        (total, scan) =>
          total +
          (Number(scan.actualRows ?? 0) +
            Number(scan.rowsRemovedByFilter ?? 0) +
            Number(scan.rowsRemovedByIndexRecheck ?? 0)) *
            Number(scan.actualLoops ?? 1),
        0,
      );
      const rowsScannedToReturnedRatio =
        actualRows > 0 ? scannedRows / actualRows : null;
      const observedIndexes = collectObservedIndexes(root.Plan);
      const observedNodeTypes = collectPlanNodeTypes(root.Plan);
      const usedSeqScan = scans.some(
        (scan) =>
          scan.relationName === 'runtime_events' &&
          scan.nodeType === 'Seq Scan',
      );
      const usedUnexpectedPlanNode = observedNodeTypes.some(
        (nodeType) => nodeType === 'Sort' || nodeType.startsWith('Bitmap'),
      );
      const verdict =
        usedSeqScan ||
        usedUnexpectedPlanNode ||
        !observedIndexes.includes(item.expectedIndex) ||
        rowsScannedToReturnedRatio === null ||
        rowsScannedToReturnedRatio > ROWS_SCANNED_TO_RETURNED_RATIO_GATE
          ? 'follow_up_required'
          : 'acceptable_evidence';
      plans.push({
        name: item.name,
        expectedIndex: item.expectedIndex,
        sql: item.sql,
        observedNodeTypes,
        observedIndexes,
        actualRows,
        rowsScannedToReturnedRatio,
        executionTimeMs: root['Execution Time'],
        scanNodes: scans,
        verdict,
      });
    }

    const artifact = {
      schemaVersion: 1,
      planName: 'runtime_event_replay',
      benchmarkRunId: RUNTIME_EVENT_REPLAY_RUN_ID,
      generatedAt: new Date().toISOString(),
      table: {
        schema: runtime.schemaName,
        name: 'runtime_events',
        cardinality,
      },
      afterEventId,
      limit: RUNTIME_EVENT_REPLAY_LIMIT,
      rowsScannedToReturnedRatioGate: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      cases: plans,
      verdict: {
        status: plans.every((item) => item.verdict === 'acceptable_evidence')
          ? 'acceptable_evidence'
          : 'follow_up_required',
      },
    };
    expect(artifact.table.cardinality).toBeGreaterThanOrEqual(
      RUNTIME_EVENT_SEED_COUNT,
    );
    expect(artifact.verdict.status).toBe('acceptable_evidence');
    expect(artifact.cases).toHaveLength(cases.length);
    for (const item of artifact.cases) {
      expect(item.observedIndexes).toContain(item.expectedIndex);
      expect(item.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
        ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      );
      expect(item.verdict).toBe('acceptable_evidence');
    }
  }, 120_000);

  it('writes event bus outbox claim EXPLAIN evidence at row volume', async () => {
    const appId = DEFAULT_APP_ID as AppId;
    const dueAt = '2026-06-17T00:00:00.000Z';
    const futureAt = '2026-06-18T00:00:00.000Z';
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('event_bus_outbox')}`;

    await runtime.service.pool.query(
      `INSERT INTO event_bus_outbox (
         id, event_type, event_version, source, app_id, runtime_event_id,
         correlation_id, payload_json, occurred_at, status, attempt_count,
         next_attempt_at, published_at, last_error, created_at, updated_at
       )
       SELECT
         'outbox-claim-explain:' || n,
         CASE WHEN n % 2 = 0 THEN $2 ELSE $3 END,
         1,
         'gantry.test',
         $4,
         NULL,
         NULL,
         '{}',
         $5::timestamptz - (n || ' seconds')::interval,
         CASE n % 5
           WHEN 0 THEN 'pending'
           WHEN 1 THEN 'failed'
           ELSE 'published'
         END,
         CASE WHEN n % 5 = 1 THEN 1 ELSE 0 END,
         CASE WHEN n % 10 IN (0, 1) THEN $5::timestamptz ELSE $6::timestamptz END,
         CASE WHEN n % 5 IN (2, 3, 4) THEN $5::timestamptz ELSE NULL END,
         CASE WHEN n % 5 = 1 THEN 'retryable test failure' ELSE NULL END,
         $5::timestamptz - (n || ' seconds')::interval,
         $5::timestamptz - (n || ' seconds')::interval
       FROM generate_series(1, $1::integer) AS series(n)`,
      [
        EVENT_BUS_OUTBOX_SEED_COUNT,
        RUNTIME_EVENT_TYPES.JOB_STARTED,
        RUNTIME_EVENT_TYPES.JOB_COMPLETED,
        appId,
        dueAt,
        futureAt,
      ],
    );
    await runtime.service.pool.query(`ANALYZE ${tableName}`);

    const counts = await runtime.service.pool.query<{
      table_cardinality: number | string;
      pending_due_count: number | string;
      failed_due_count: number | string;
      published_count: number | string;
      future_pending_count: number | string;
    }>(
      `SELECT
         COUNT(*)::int AS table_cardinality,
         (COUNT(*) FILTER (
           WHERE status = 'pending' AND next_attempt_at <= $1
         ))::int AS pending_due_count,
         (COUNT(*) FILTER (
           WHERE status = 'failed' AND next_attempt_at <= $1
         ))::int AS failed_due_count,
         (COUNT(*) FILTER (WHERE status = 'published'))::int AS published_count,
         (COUNT(*) FILTER (
           WHERE status = 'pending' AND next_attempt_at > $1
         ))::int AS future_pending_count
       FROM ${tableName}`,
      [dueAt],
    );
    const tableCardinality = Number(counts.rows[0]?.table_cardinality ?? 0);
    expect(tableCardinality).toBeGreaterThanOrEqual(
      EVENT_BUS_OUTBOX_SEED_COUNT,
    );
    expect(Number(counts.rows[0]?.pending_due_count ?? 0)).toBeGreaterThan(
      EVENT_BUS_OUTBOX_CLAIM_LIMIT,
    );
    expect(Number(counts.rows[0]?.failed_due_count ?? 0)).toBeGreaterThan(
      EVENT_BUS_OUTBOX_CLAIM_LIMIT,
    );
    expect(Number(counts.rows[0]?.published_count ?? 0)).toBeGreaterThan(0);
    expect(Number(counts.rows[0]?.future_pending_count ?? 0)).toBeGreaterThan(
      0,
    );

    const cases = [
      {
        name: 'pending_due_claim',
        expectedIndex: 'idx_event_bus_outbox_claim_due',
        sql: `SELECT * FROM ${tableName} WHERE status = $1 AND next_attempt_at <= $2 ORDER BY next_attempt_at ASC, created_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED`,
        values: ['pending', dueAt, EVENT_BUS_OUTBOX_CLAIM_LIMIT],
      },
      {
        name: 'failed_due_claim',
        expectedIndex: 'idx_event_bus_outbox_claim_due',
        sql: `SELECT * FROM ${tableName} WHERE status = $1 AND next_attempt_at <= $2 ORDER BY next_attempt_at ASC, created_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED`,
        values: ['failed', dueAt, EVENT_BUS_OUTBOX_CLAIM_LIMIT],
      },
    ];

    const plans = [];
    const client = await runtime.service.pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of cases) {
        const explain = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${item.sql}`,
          item.values,
        );
        const root = normalizeExplainPayload(explain.rows[0]?.['QUERY PLAN']);
        const scans = collectScanNodes(root.Plan);
        const actualRows = planNumber(root.Plan, 'Actual Rows') ?? 0;
        const scannedRows = scans.reduce(
          (total, scan) =>
            total +
            (Number(scan.actualRows ?? 0) +
              Number(scan.rowsRemovedByFilter ?? 0) +
              Number(scan.rowsRemovedByIndexRecheck ?? 0)) *
              Number(scan.actualLoops ?? 1),
          0,
        );
        const rowsScannedToReturnedRatio =
          actualRows > 0 ? scannedRows / actualRows : null;
        const observedIndexes = collectObservedIndexes(root.Plan);
        const observedNodeTypes = collectPlanNodeTypes(root.Plan);
        const usedSeqScan = scans.some(
          (scan) =>
            scan.relationName === 'event_bus_outbox' &&
            scan.nodeType === 'Seq Scan',
        );
        const usedUnexpectedPlanNode = observedNodeTypes.some(
          (nodeType) => nodeType === 'Sort' || nodeType.startsWith('Bitmap'),
        );
        const verdict =
          usedSeqScan ||
          usedUnexpectedPlanNode ||
          !observedIndexes.includes(item.expectedIndex) ||
          rowsScannedToReturnedRatio === null ||
          rowsScannedToReturnedRatio > ROWS_SCANNED_TO_RETURNED_RATIO_GATE
            ? 'follow_up_required'
            : 'acceptable_evidence';
        plans.push({
          name: item.name,
          expectedIndex: item.expectedIndex,
          sql: item.sql,
          observedNodeTypes,
          observedIndexes,
          actualRows,
          rowsScannedToReturnedRatio,
          executionTimeMs: root['Execution Time'],
          scanNodes: scans,
          verdict,
        });
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    const artifact = {
      schemaVersion: 1,
      planName: 'event_bus_outbox_due_claim',
      benchmarkRunId: EVENT_BUS_OUTBOX_CLAIM_RUN_ID,
      generatedAt: new Date().toISOString(),
      dispatcherStatus: 'future_dispatcher_claim_shape_only',
      table: {
        schema: runtime.schemaName,
        name: 'event_bus_outbox',
        cardinality: tableCardinality,
      },
      counts: {
        pendingDueCount: Number(counts.rows[0]?.pending_due_count ?? 0),
        failedDueCount: Number(counts.rows[0]?.failed_due_count ?? 0),
        publishedCount: Number(counts.rows[0]?.published_count ?? 0),
        futurePendingCount: Number(counts.rows[0]?.future_pending_count ?? 0),
      },
      limit: EVENT_BUS_OUTBOX_CLAIM_LIMIT,
      rowsScannedToReturnedRatioGate: ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      cases: plans,
      verdict: {
        status: plans.every((item) => item.verdict === 'acceptable_evidence')
          ? 'acceptable_evidence'
          : 'follow_up_required',
      },
    };
    expect(artifact.table.cardinality).toBeGreaterThanOrEqual(
      EVENT_BUS_OUTBOX_SEED_COUNT,
    );
    expect(artifact.dispatcherStatus).toBe(
      'future_dispatcher_claim_shape_only',
    );
    expect(artifact.verdict.status).toBe('acceptable_evidence');
    expect(artifact.cases).toHaveLength(cases.length);
    for (const item of artifact.cases) {
      expect(item.observedIndexes).toContain(item.expectedIndex);
      expect(item.rowsScannedToReturnedRatio).toBeLessThanOrEqual(
        ROWS_SCANNED_TO_RETURNED_RATIO_GATE,
      );
      expect(item.verdict).toBe('acceptable_evidence');
    }
  }, 120_000);
});
