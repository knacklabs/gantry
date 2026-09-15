import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';
import type { AppId } from '@core/domain/app/app.js';
import {
  hashProviderSessionExternalId,
  publishProviderSessionRuntimeEvent,
} from '@core/domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const OPERATIONS_DOCUMENT = new URL(
  '../../../../docs/memory/provider-session-ceiling-operations.md',
  import.meta.url,
);
const PROVIDER_SESSION_HASH = hashProviderSessionExternalId(
  'provider-session-secret',
);

function observabilityRecipeSql(): string {
  const document = fs.readFileSync(OPERATIONS_DOCUMENT, 'utf8');
  const match = document.match(
    /<!-- provider-session-ceiling-observability-sql:start -->\s*```sql\s*([\s\S]*?)\s*```\s*<!-- provider-session-ceiling-observability-sql:end -->/,
  );
  if (!match?.[1]) throw new Error('Observability SQL block is missing.');
  return match[1];
}

maybeDescribe('provider session ceiling operations', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'provider_session_ceiling_operations',
    });
    const publish = async (
      event: Parameters<
        typeof runtime.repositories.runtimeEvents.appendRuntimeEvent
      >[0],
    ) => {
      await runtime.repositories.runtimeEvents.appendRuntimeEvent(event);
    };
    await publishProviderSessionRuntimeEvent(publish, {
      appId: DEFAULT_APP_ID as AppId,
      eventType: RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED,
      payload: {
        reason: 'ceiling',
        providerSessionHash: PROVIDER_SESSION_HASH,
        executionProviderId: 'claude-code',
        contextHighWaterMark: 150_001,
        cap: 150_000,
      },
    });
    await publishProviderSessionRuntimeEvent(publish, {
      appId: DEFAULT_APP_ID as AppId,
      eventType: RUNTIME_EVENT_TYPES.SESSION_PROVIDER_CLEANUP_FAILED,
      payload: {
        providerSessionHash: PROVIDER_SESSION_HASH,
        executionProviderId: 'claude-code',
        error: 'release failed',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('queries and projects both retirement event families', async () => {
    const appId = DEFAULT_APP_ID as AppId;

    const events = await runtime.repositories.runtimeEvents.listRuntimeEvents({
      appId,
      eventTypes: [
        RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED,
        RUNTIME_EVENT_TYPES.SESSION_PROVIDER_CLEANUP_FAILED,
      ],
    });

    expect(events).toMatchObject([
      {
        eventType: RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED,
        actor: { kind: 'system', source: 'runtime' },
        responseMode: 'none',
        payload: {
          reason: 'ceiling',
          providerSessionHash: PROVIDER_SESSION_HASH,
          executionProviderId: 'claude-code',
          contextHighWaterMark: 150_001,
          cap: 150_000,
        },
      },
      {
        eventType: RUNTIME_EVENT_TYPES.SESSION_PROVIDER_CLEANUP_FAILED,
        actor: { kind: 'system', source: 'runtime' },
        responseMode: 'none',
        payload: {
          providerSessionHash: PROVIDER_SESSION_HASH,
          executionProviderId: 'claude-code',
          error: 'release failed',
        },
      },
    ]);

    const projection = await runtime.service.pool.query<{
      event_type: string;
      payload_json: string;
    }>(
      `SELECT event_type, payload_json
       FROM event_bus_outbox
       WHERE event_type IN ($1, $2)
       ORDER BY runtime_event_id`,
      [
        RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED,
        RUNTIME_EVENT_TYPES.SESSION_PROVIDER_CLEANUP_FAILED,
      ],
    );
    expect(projection.rows.map((row) => row.event_type)).toEqual([
      RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED,
      RUNTIME_EVENT_TYPES.SESSION_PROVIDER_CLEANUP_FAILED,
    ]);
    expect(
      projection.rows.map(
        (row) =>
          (
            JSON.parse(row.payload_json) as {
              runtimeEvent: { payload: unknown };
            }
          ).runtimeEvent.payload,
      ),
    ).toEqual(events.map((event) => event.payload));
  });

  it('executes the observability recipe extracted from the operations document', async () => {
    const result = await runtime.service.pool.query<{
      event_type: string;
      reason: string | null;
      event_count: number;
    }>(observabilityRecipeSql());

    expect(result.rows).toEqual(
      expect.arrayContaining([
        {
          event_type: RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED,
          reason: 'ceiling',
          event_count: 1,
        },
        {
          event_type: RUNTIME_EVENT_TYPES.SESSION_PROVIDER_CLEANUP_FAILED,
          reason: null,
          event_count: 1,
        },
      ]),
    );
  });
});
