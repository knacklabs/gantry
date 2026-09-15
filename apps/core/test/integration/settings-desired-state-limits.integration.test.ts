import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { SettingsRevision } from '@core/domain/ports/fleet-capability-state.js';

const revisions = vi.hoisted(() => [] as SettingsRevision[]);

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    ops: {},
    service: { pool: {} },
    repositories: {
      settingsRevisions: {
        getLatestSettingsRevision: async () => revisions.at(-1) ?? null,
      },
    },
  }),
}));

import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import { settingsToRevisionDocument } from '@core/config/settings/settings-import-service.js';
import { handleSettingsRoutes } from '@core/control/server/routes/settings.js';

type TestResponse = ServerResponse & { body: string };

describe('settings desired-state limits', () => {
  beforeEach(() => revisions.splice(0));

  it('round-trips the cap through PUT and GET on /v1/settings/desired-state', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.limits.providerSessionMaxInputTokens = 360_000;
    const context = controlContext();

    const put = await invoke(context, 'PUT', {
      settings: settingsToRevisionDocument(settings),
    });
    expect(put.statusCode).toBe(200);

    const get = await invoke(context, 'GET');
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body).settings.limits).toMatchObject({
      provider_session_max_input_tokens: 360_000,
    });
  });
});

function controlContext(): ControlRouteContext {
  const settings = createDefaultRuntimeSettings();
  settings.runtime.deploymentMode = 'fleet';
  return {
    keys: [
      {
        kid: 'admin',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(['agents:admin']),
        appId: 'default',
      },
    ],
    runtimeHome: '/tmp/gantry-settings-limits-test',
    getRuntimeSettings: () => settings,
    getInternalRuntimeSettings: () => settings,
    settingsImport: {
      serializeRevisionDocument: settingsToRevisionDocument,
      importFleet: async (_deps, nextSettings, options) => {
        revisions.push({
          appId: 'default',
          revision: revisions.length + 1,
          settingsDocument: settingsToRevisionDocument(nextSettings),
          minReaderVersion: 16,
          createdBy: 'control-api:admin',
          note: options.note ?? null,
          createdAt: new Date().toISOString(),
        });
        return { status: 'applied', revision: revisions.length };
      },
      importWorkstation: async () => ({ status: 'no_op' }),
      classifyImportError: () => null,
    },
  } as ControlRouteContext;
}

async function invoke(
  context: ControlRouteContext,
  method: 'GET' | 'PUT',
  body?: unknown,
): Promise<TestResponse> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const request = Readable.from(raw ? [raw] : []) as IncomingMessage;
  request.method = method;
  request.headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw).toString(),
  };
  const response = {
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
  await handleSettingsRoutes(
    request,
    response,
    context,
    '/v1/settings/desired-state',
  );
  return response;
}
