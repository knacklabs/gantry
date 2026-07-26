import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { ObserverInsightCreate } from '@core/domain/ports/observer-insights.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// The observer routes read the process-wide storage singleton. Point it at the
// live Postgres harness so POST /observer/preview and GET /observer/deliveries
// exercise the real repository (listPendingForDigest / listDigestDeliveries) end
// to end. NOTE: this is the strongest end-to-end reach available in this
// environment for a scheduled system job — a full agent-e2e that drives the
// __system:observer_digest cron with a hermetic provider still needs CI/human
// (see the report's agent-e2e delta statement).
const storageHolder = vi.hoisted(
  () => ({ storage: null as unknown }) as { storage: unknown },
);
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => storageHolder.storage,
}));

const { handleObserverRoutes } =
  await import('@core/control/server/routes/observer.js');

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'default';
const RECIPIENT = 'owner-1';

function configuredSettings() {
  const settings = createDefaultRuntimeSettings();
  settings.providers.telegram = { enabled: true };
  settings.memory.enabled = true;
  settings.memory.dreaming.enabled = true;
  settings.memory.embeddings.enabled = true;
  settings.memory.embeddings.provider = 'openai';
  settings.observer = {
    enabled: true,
    owner: { recipient: RECIPIENT, conversation: 'owner_dm' },
    delivery: {
      enabled: true,
      timezone: 'UTC',
      sendAt: '09:00',
      maxInsights: 5,
    },
  };
  settings.providerAccounts.telegram_default = {
    agentId: 'main_agent',
    provider: 'telegram',
    label: 'Telegram',
    runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
  };
  settings.conversations.owner_dm = {
    providerAccount: 'telegram_default',
    externalId: RECIPIENT,
    kind: 'dm',
    displayName: 'Owner DM',
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: [RECIPIENT],
  };
  return settings;
}

function context(): ControlRouteContext {
  const settings = configuredSettings();
  return {
    keys: [
      {
        kid: 'observer-test',
        tokenHash: createHash('sha256').update('observer-test-token').digest(),
        scopes: new Set(['memory:read']),
        appId: APP_ID,
      },
    ],
    getInternalRuntimeSettings: () => settings,
  } as ControlRouteContext;
}

function request(method = 'GET'): IncomingMessage {
  return {
    method,
    headers: { authorization: 'Bearer observer-test-token' },
  } as IncomingMessage;
}

type TestResponse = ServerResponse & { body: string };
function responseRecorder(): TestResponse {
  return {
    statusCode: 0,
    body: '',
    setHeader() {
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as TestResponse;
}

function insight(
  id: string,
  overrides: Partial<ObserverInsightCreate> = {},
): ObserverInsightCreate {
  return {
    id,
    appId: APP_ID,
    subject: 'observer:app',
    insightType: 'commitment',
    title: `Insight ${id}`,
    summary: `Summary ${id}`,
    evidenceRefs: [
      {
        conversationId: 'tg:observed',
        messageId: id,
        ts: '2026-07-24T07:54:00.000Z',
        providerAccountId: 'telegram_default',
        conversationJid: 'tg:observed',
      },
    ],
    batchSnapshotAt: '2026-07-24T07:55:00.000Z',
    evidenceVersion: 1,
    canonicalSignature: `signature:${id}`,
    confidence: 0.9,
    priorityScore: 0.5,
    recipient: RECIPIENT,
    nowIso: '2026-07-24T08:00:00.000Z',
    ...overrides,
  };
}

maybeDescribe(
  'observer preview + deliveries control round-trip (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'observer_preview_ctl',
      });
      storageHolder.storage = {
        repositories: runtime.repositories,
        ops: runtime.ops,
      };
      await runtime.repositories.apps.saveApp({
        id: APP_ID as never,
        slug: APP_ID,
        name: 'Observer preview control test',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
      });
      // No messages after the snapshot => freshness probe reports fresh.
      await runtime.repositories.observerInsights.create(
        insight('p-hi', { priorityScore: 0.9 }),
      );
      await runtime.repositories.observerInsights.create(
        insight('p-lo', { priorityScore: 0.1 }),
      );
    }, 60_000);

    afterAll(async () => {
      await runtime.cleanup();
    });

    it('POST /observer/preview renders the top-N and writes NOTHING', async () => {
      const res = responseRecorder();
      const url = new URL('http://localhost/v1/observer/preview');

      await expect(
        handleObserverRoutes(
          request('POST'),
          res,
          context(),
          url,
          url.pathname,
        ),
      ).resolves.toBe(true);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ eligible: true, recipient: RECIPIENT });
      // Priority ordering preserved: p-hi before p-lo.
      expect(body.selected.map((s: { id: string }) => s.id)).toEqual([
        'p-hi',
        'p-lo',
      ]);
      expect(body.renderedDigest).toContain('Insight p-hi');

      // Zero-write invariant against the real database: no reservation exists and
      // the candidates are still 'pending' (never claimed).
      const repo = runtime.repositories.observerInsights;
      expect(
        await repo.findDigestReservation({
          appId: APP_ID,
          recipient: RECIPIENT,
          localDay: body.localDay,
        }),
      ).toBeNull();
      expect(
        await repo.listDigestDeliveries({
          appId: APP_ID,
          recipient: RECIPIENT,
          limit: 10,
        }),
      ).toEqual([]);
      const pending = await repo.listPendingForDigest({
        appId: APP_ID,
        recipient: RECIPIENT,
        limit: 10,
      });
      expect(pending.map((p) => p.id).sort()).toEqual(['p-hi', 'p-lo']);
    });

    it('GET /observer/deliveries returns history with state + insight count', async () => {
      const repo = runtime.repositories.observerInsights;
      // Reserve a delivery (2 members) so history has a real settled/reserved row.
      const claimed = await repo.claimPendingForDigest({
        appId: APP_ID,
        recipient: RECIPIENT,
        limit: 10,
        nowIso: '2026-07-24T09:00:00.000Z',
      });
      await repo.reserveDigest({
        id: 'delivery-hist',
        appId: APP_ID,
        recipient: RECIPIENT,
        localDay: '2026-07-24',
        timezone: 'UTC',
        conversationJid: 'tg:observed',
        providerAccountId: 'telegram_default',
        renderedDigest: 'History digest',
        contentHash: 'hash-hist',
        memberships: claimed.map((c, position) => ({
          insightId: c.id,
          claimedAt: c.updatedAt,
          position,
        })),
        nowIso: '2026-07-24T09:00:01.000Z',
      });

      const res = responseRecorder();
      const url = new URL('http://localhost/v1/observer/deliveries?limit=10');
      await expect(
        handleObserverRoutes(request(), res, context(), url, url.pathname),
      ).resolves.toBe(true);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.recipient).toBe(RECIPIENT);
      expect(body.deliveries).toHaveLength(1);
      expect(body.deliveries[0]).toMatchObject({
        id: 'delivery-hist',
        localDay: '2026-07-24',
        state: 'reserved',
        insightCount: claimed.length,
      });
    });
  },
);
