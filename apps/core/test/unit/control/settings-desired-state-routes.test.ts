import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Scope } from '@core/control/server/auth.js';
import type { SettingsRevision } from '@core/domain/ports/fleet-capability-state.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import type { RuntimeSettings } from '@core/config/settings/runtime-settings-types.js';

const revisions = vi.hoisted(() => [] as SettingsRevision[]);
const importOutcome = vi.hoisted(() => ({
  current: { status: 'applied', revision: 1 } as
    | { status: 'applied'; revision: number }
    | { status: 'invalid'; errors: string[] }
    | { status: 'conflict'; expectedRevision: number; actualRevision: number },
}));
const workstationImports = vi.hoisted(() => [] as unknown[]);
const parsedDocuments = vi.hoisted(() => [] as Record<string, unknown>[]);
const workstationImportOutcome = vi.hoisted(() => ({
  current: { revision: 11 } as { revision?: number },
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
    importWorkstationSettings: vi.fn(async (deps, settings) => {
      workstationImports.push({ deps, settings });
      return workstationImportOutcome.current;
    }),
  };
});

vi.mock('@core/config/settings/runtime-settings-parser.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/config/settings/runtime-settings-parser.js')
  >('@core/config/settings/runtime-settings-parser.js');
  return {
    ...actual,
    parseRuntimeSettingsObject: (document: Record<string, unknown>) => {
      parsedDocuments.push(structuredClone(document));
      if (document.PARSE_FAIL)
        throw new Error('agent.name must be a non-empty string');
      return {} as never;
    },
  };
});

import { handleSettingsRoutes } from '@core/control/server/routes/settings.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

beforeEach(() => {
  revisions.length = 0;
  importOutcome.current = { status: 'applied', revision: 1 };
  workstationImportOutcome.current = { revision: 11 };
  workstationImports.length = 0;
  parsedDocuments.length = 0;
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

  it('returns revision 0 with null settings when no revision is seeded', async () => {
    const res = await invoke('GET', '/v1/settings/desired-state', undefined);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      revision: 0,
      settings: null,
    });
  });

  it('returns the latest revision typed document', async () => {
    revisions.push({
      appId: 'default',
      revision: 4,
      settingsDocument: { agent: { name: 'Ada' } },
      minReaderVersion: 1,
      createdBy: 'cli',
      note: 'seed',
      createdAt: '2026-06-11T00:00:00.000Z',
    });
    const res = await invoke('GET', '/v1/settings/desired-state', undefined);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      revision: 4,
      settings: { agent: { name: 'Ada' } },
      note: 'seed',
    });
  });

  it('strips the private observability block from desired-state reads', async () => {
    revisions.push({
      appId: 'default',
      revision: 5,
      settingsDocument: {
        agent: { name: 'Ada' },
        observability: {
          tracing: { enabled: true, endpoint: 'https://otlp.example.test' },
        },
      },
      minReaderVersion: 1,
      createdBy: 'cli',
      note: 'seed',
      createdAt: '2026-06-11T00:00:00.000Z',
    });
    const res = await invoke('GET', '/v1/settings/desired-state', undefined);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.settings.agent).toEqual({ name: 'Ada' });
    expect(payload.settings.observability).toBeUndefined();
  });

  it('rejects a non-object settings document with a 400', async () => {
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settings: 'not-an-object',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 with document-path errors for an unparseable document', async () => {
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settings: { PARSE_FAIL: true },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_SETTINGS');
    expect(body.error.message).toContain('agent.name');
  });

  it('surfaces validation errors as a path-level 400', async () => {
    importOutcome.current = {
      status: 'invalid',
      errors: ['agents.x.capabilities contains unavailable capability foo'],
    };
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settings: { agent: {} },
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
      settings: { agent: {} },
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
      settings: { agent: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revision: 7 });
  });

  it('preserves private observability from internal settings on the first revision', async () => {
    const res = await invoke(
      'PUT',
      '/v1/settings/desired-state',
      {
        settings: {
          agent: {},
          observability: { tracing: { endpoint: 'https://untrusted.test' } },
        },
      },
      {
        internalObservability: {
          tracing: {
            enabled: true,
            endpoint: 'https://trusted.test',
            captureContent: false,
            sampleRate: 0.25,
          },
        },
      },
    );

    expect(res.statusCode).toBe(200);
    expect(parsedDocuments.at(-1)).toMatchObject({
      agent: {},
      observability: {
        tracing: {
          enabled: true,
          endpoint: 'https://trusted.test',
          capture_content: false,
          sample_rate: 0.25,
        },
      },
    });
  });

  it('writes desired-state through the workstation import path in workstation mode', async () => {
    const res = await invoke(
      'PUT',
      '/v1/settings/desired-state',
      {
        settings: { agent: {} },
      },
      { deploymentMode: 'workstation' },
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revision: 11 });
    expect(workstationImports).toHaveLength(1);
  });

  it('returns the latest revision for workstation no-op updates', async () => {
    workstationImportOutcome.current = {};
    revisions.push({
      appId: 'default',
      revision: 12,
      settingsDocument: { agent: { name: 'Ada' } },
      minReaderVersion: 1,
      createdBy: 'cli',
      note: 'latest',
      createdAt: '2026-06-11T00:00:00.000Z',
    });

    const res = await invoke(
      'PUT',
      '/v1/settings/desired-state',
      {
        settings: { agent: {} },
      },
      { deploymentMode: 'workstation' },
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revision: 12 });
  });

  it('accepts revision guards in workstation mode', async () => {
    const res = await invoke(
      'PUT',
      '/v1/settings/desired-state',
      {
        settings: { agent: {} },
        expectedRevision: 3,
      },
      { deploymentMode: 'workstation' },
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revision: 11 });
    expect(workstationImports).toHaveLength(1);
    expect(workstationImports[0]).toMatchObject({
      deps: {
        revisionMirrorRequired: true,
        expectedRevision: 3,
      },
    });
  });

  it('rejects a non-integer expectedRevision', async () => {
    const res = await invoke('PUT', '/v1/settings/desired-state', {
      settings: { agent: {} },
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
        settingsDocument: {},
        minReaderVersion: 1,
        createdBy: 'cli',
        note: 'first',
        createdAt: '2026-06-11T00:00:00.000Z',
      },
      {
        appId: 'default',
        revision: 2,
        settingsDocument: {},
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
  options: {
    authorization?: string | null;
    scopes?: Scope[];
    deploymentMode?: 'workstation' | 'fleet';
    internalObservability?: RuntimeSettings['observability'];
  } = {},
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
  await handleSettingsRoutes(
    req,
    res,
    mockContext(
      options.scopes,
      options.deploymentMode,
      options.internalObservability,
    ),
    pathname,
  );
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

function mockContext(
  scopes: Scope[] = ['agents:admin'],
  deploymentMode: 'workstation' | 'fleet' = 'fleet',
  internalObservability?: RuntimeSettings['observability'],
): ControlRouteContext {
  const internalSettings = createDefaultRuntimeSettings();
  internalSettings.runtime.deploymentMode = deploymentMode;
  if (internalObservability) {
    internalSettings.observability = internalObservability;
  }
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
    getRuntimeSettings: () => internalSettings,
    getInternalRuntimeSettings: () => internalSettings,
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () =>
      ({ defaults: {} }) as ReturnType<ControlRouteContext['getModelDefaults']>,
    patchModelDefaults: () => ({ ok: true }),
    preflightModelProvider: async () => ({
      ok: true,
      status: 'pass',
      message: 'ok',
    }),
    getActiveModelCredentialProviderIds: async () => [],
    countPendingAccessRequests: async () => 0,
    listControlPlaneJobs: async () => [],
    syncSettingsFromProjection: async () => undefined,
    getSelectedAgentHarness: () => 'auto',
  };
}
