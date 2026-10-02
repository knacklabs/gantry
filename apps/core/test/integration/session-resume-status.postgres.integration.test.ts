import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import type { ProviderSession } from '@core/domain/sessions/sessions.js';

import { startTestControlServer } from '../harness/control-http-server.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

// Fix owner: sdk-session-status-searches-obsolete-sha.
const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('session resume status through HTTP (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let server: Awaited<ReturnType<typeof startTestControlServer>>;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'resume_status',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    server = await startTestControlServer({
      token: 'token-resume-status',
      appId: 'default',
      scopes: ['sessions:read', 'sessions:write'],
      runtimeApp: { registerGroup: async () => undefined },
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (runtime) await runtime.cleanup();
  }, 60_000);

  it('reports provider resume availability from the canonical session handle', async () => {
    const headers = {
      authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    };
    for (const [index, handle] of ['', '   ', 'provider-handle'].entries()) {
      const ensured = await fetch(`${server.baseUrl}/v1/sessions/ensure`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversationId: `resume-status-${index}` }),
      });
      expect(ensured.status).toBe(200);
      const { sessionId } = (await ensured.json()) as { sessionId: string };
      const now = new Date().toISOString() as ProviderSession['createdAt'];
      await runtime.repositories.providerSessions.saveProviderSession({
        id: `provider-status-${index}` as ProviderSession['id'],
        appId: 'default' as ProviderSession['appId'],
        agentSessionId: sessionId as ProviderSession['agentSessionId'],
        provider: 'test' as ProviderSession['provider'],
        externalSessionId: handle,
        providerRef: { kind: 'provider_session', value: `test:${handle}` },
        metadata: { label: 'status fixture' },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const response = await fetch(
        `${server.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
        { headers },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        providerSession: Record<string, unknown>;
      };
      expect(body.providerSession).toEqual({
        provider: 'test',
        status: 'active',
        hasProviderResume: index === 2,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(
        new Date(body.providerSession.createdAt as string).toISOString(),
      ).toBe(now);
      expect(
        new Date(body.providerSession.updatedAt as string).toISOString(),
      ).toBe(now);
    }
  });
});
