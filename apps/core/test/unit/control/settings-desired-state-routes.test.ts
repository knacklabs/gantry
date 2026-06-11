import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Scope } from '@core/control/server/auth.js';
import type { SettingsRevision } from '@core/domain/ports/fleet-capability-state.js';

const revisions = vi.hoisted(() => [] as SettingsRevision[]);
const importOutcome = vi.hoisted(() => ({
  current: { status: 'applied', revision: 1 } as
    | { status: 'applied'; revision: number }
    | { status: 'invalid'; errors: string[] }
    | { status: 'conflict'; expectedRevision: number; actualRevision: number },
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    ops: {},
    service: { pool: {} },
    repositories: {
      settingsRevisions: {
        getLatestSettingsRevision: async () => revisions.at(-1) ?? null,
        listRecentSettingsRevisions: async () => [...revisions].reverse(),
      },
    },
  }),
}));

vi.mock('@core/config/settings/settings-import-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/config/settings/settings-import-service.js')
  >('@core/config/settings/settings-import-service.js');
  return {
    ...actual,
    importFleetSettingsRevision: vi.fn(async () => importOutcome.current),
  };
});

vi.mock('@core/config/settings/runtime-settings-parser.js', () => ({
  parseRuntimeSettings: (raw: string) => {
    if (raw.includes('PARSE_FAIL')) throw new Error('bad yaml');
    return {} as never;
  },
}));

import { handleSettingsRoutes } from '@core/control/server/routes/settings.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

beforeEach(() => {
  revisions.length = 0;
  importOutcome.current = { status: 'applied', revision: 1 };
});

describe('settings desired-state control routes', () => {
  it('requires agents:admin and a bearer token to read desired state', async () => {
    const noAuth = await invoke(
      'GET',
      '/v1/settings/desired-state',
      undefined,
      {
        authorization: null,
      },
    );
    expect(noAuth.statusCode).toBe(401);

    const wrongScope = await invoke(
      'GET',
      '/v1/settings/desired-state',
      undefined,
      { scopes: ['sessions:read'] },
    );
    expect(wrongScope.statusCode).toBe(403);
  });

  it('returns revision 0 with null yaml when no revision is seeded', async () => {
    const res = await invoke('GET', '/v1/settings/desired-state', undefined);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      revision: 0,
      settingsYaml: null,
    });
  });

  it('returns the latest revision document', async () => {
    revisions.push({
      appId: 'default',
      revision: 4,
      settingsDocument: { yaml: 'agent: {}' },
      minReaderVersion: 1,
      createdBy: 'cli',
      note: 'seed',
      createdAt: '2026-06-11T00:00:00.000Z',
    });
    const res = await invoke('GET', '/v1/settings/desired-state', undefined);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      revision: 4,
      settingsYaml: 'agent: {}',
      note: 'seed',
    });
  });

  it('rejects an empty settings document with a path-level 400', async () => {
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settingsYaml: '   ',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 with parse errors for an unparseable document', async () => {
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settingsYaml: 'PARSE_FAIL',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_SETTINGS');
  });

  it('surfaces validation errors as a path-level 400', async () => {
    importOutcome.current = {
      status: 'invalid',
      errors: ['agents.x.capabilities contains unavailable capability foo'],
    };
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settingsYaml: 'agent: {}',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_SETTINGS');
    expect(body.error.details.errors).toEqual(importOutcome.current.errors);
  });

  it('returns 409 on a stale expected revision', async () => {
    importOutcome.current = {
      status: 'conflict',
      expectedRevision: 2,
      actualRevision: 5,
    };
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settingsYaml: 'agent: {}',
      expectedRevision: 2,
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('REVISION_CONFLICT');
    expect(body.error.details).toMatchObject({
      expectedRevision: 2,
      actualRevision: 5,
    });
  });

  it('returns the new revision number on a successful update', async () => {
    importOutcome.current = { status: 'applied', revision: 7 };
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settingsYaml: 'agent: {}',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revision: 7 });
  });

  it('rejects a non-integer expectedRevision', async () => {
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settingsYaml: 'agent: {}',
      expectedRevision: 'latest',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_REQUEST');
  });

  it('lists recent revisions with note and created_by', async () => {
    revisions.push(
      {
        appId: 'default',
        revision: 1,
        settingsDocument: { yaml: '' },
        minReaderVersion: 1,
        createdBy: 'cli',
        note: 'first',
        createdAt: '2026-06-11T00:00:00.000Z',
      },
      {
        appId: 'default',
        revision: 2,
        settingsDocument: { yaml: '' },
        minReaderVersion: 1,
        createdBy: 'control-api:admin',
        note: null,
        createdAt: '2026-06-11T01:00:00.000Z',
      },
    );
    const res = await invoke('GET', '/v1/settings/revisions', undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.revisions).toHaveLength(2);
    expect(body.revisions[0]).toMatchObject({
      revision: 2,
      createdBy: 'control-api:admin',
    });
  });

  it('requires agents:admin to list revisions', async () => {
    const res = await invoke('GET', '/v1/settings/revisions', undefined, {
      scopes: ['sessions:read'],
    });
    expect(res.statusCode).toBe(403);
  });
});

async function invoke(
  method: string,
  pathname: string,
  body: unknown,
  options: { authorization?: string | null; scopes?: Scope[] } = {},
): Promise<TestResponse> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw).toString(),
    ...(options.authorization !== undefined
      ? options.authorization !== null
        ? { authorization: options.authorization }
        : {}
      : { authorization: 'Bearer test-token' }),
  };
  const res = responseRecorder();
  await handleSettingsRoutes(req, res, mockContext(options.scopes), pathname);
  return res;
}

function responseRecorder(): TestResponse {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(name: string, value: number | string | string[]) {
      this.headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(', ')
        : String(value);
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as TestResponse;
}

function mockContext(scopes: Scope[] = ['agents:admin']): ControlRouteContext {
  return {
    app: {} as ControlRouteContext['app'],
    runtimeHome: '/tmp/gantry-test',
    keys: [
      {
        kid: 'admin',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(scopes),
        appId: 'default',
      },
    ],
    socketPath: '/tmp/gantry-control.sock',
    port: 8787,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
    triggerRateLimiter: { consume: () => true },
    getRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getRuntimeSettings']>,
    getInternalRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getInternalRuntimeSettings']>,
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () =>
      ({ defaults: {} }) as ReturnType<ControlRouteContext['getModelDefaults']>,
    patchModelDefaults: () => ({ ok: true }),
    preflightModelPreset: async () => ({
      ok: true,
      status: 'pass',
      message: 'ok',
    }),
    getActiveModelCredentialProviderIds: async () => [],
    countPendingAccessRequests: async () => 0,
    listControlPlaneJobs: async () => [],
    syncSettingsFromProjection: async () => undefined,
  };
}
