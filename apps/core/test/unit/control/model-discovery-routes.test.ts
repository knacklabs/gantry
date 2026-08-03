import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';

const latestRevision = vi.hoisted(() => ({
  current: {
    appId: 'default',
    revision: 5,
    settingsDocument: {
      model_aliases: { existing: { provider: 'provider-a' } },
    },
  } as Record<string, unknown> | null,
}));
const desiredStateWrites = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      settingsRevisions: {
        getLatestSettingsRevision: async () => latestRevision.current,
      },
    },
  }),
}));

vi.mock('@core/control/server/routes/settings.js', () => ({
  writeControlDesiredState: vi.fn(async (input: Record<string, unknown>) => {
    desiredStateWrites.push(input);
    (input.respond as ((revision: number) => void) | undefined)?.(6);
  }),
}));

import { handleModelRoutes } from '@core/control/server/routes/models.js';

type TestResponse = ServerResponse & { body: string };

beforeEach(() => {
  latestRevision.current = {
    appId: 'default',
    revision: 5,
    settingsDocument: {
      model_aliases: { existing: { provider: 'provider-a' } },
    },
  };
  desiredStateWrites.length = 0;
});

describe('model discovery control routes', () => {
  it('lists provider models with read scope', async () => {
    const list = vi.fn(async () => ({
      providerId: 'anthropic',
      providerLabel: 'Anthropic',
      discoverySource: 'live',
      refreshedAt: '2026-08-03T00:00:00.000Z',
      refreshError: null,
      models: [],
    }));
    const res = await invoke(
      'GET',
      '/v1/model-providers/anthropic/models',
      undefined,
      context({ list }),
    );

    expect(res.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({
      appId: 'default',
      providerId: 'anthropic',
    });
  });

  it('passes an explicit refresh request to discovery', async () => {
    const list = vi.fn(async () => ({
      providerId: 'anthropic',
      providerLabel: 'Anthropic',
      discoverySource: 'live' as const,
      refreshedAt: '2026-08-03T00:00:00.000Z',
      refreshError: null,
      models: [],
    }));
    await invoke(
      'GET',
      '/v1/model-providers/anthropic/models?refresh=true',
      undefined,
      context({ list }),
    );

    expect(list).toHaveBeenCalledWith({
      appId: 'default',
      providerId: 'anthropic',
      force: true,
    });
  });

  it('rejects a stale settings revision before provider discovery', async () => {
    const prepareRegistration = vi.fn();
    const res = await invoke(
      'POST',
      '/v1/model-registrations',
      {
        providerId: 'openrouter',
        providerModelId: 'vendor/new-model',
        alias: 'new-model',
        expectedRevision: 4,
      },
      context({ prepareRegistration }),
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('REVISION_CONFLICT');
    expect(prepareRegistration).not.toHaveBeenCalled();
    expect(desiredStateWrites).toHaveLength(0);
  });

  it('merges an explicit registration into the revision-safe desired-state write', async () => {
    const prepareRegistration = vi.fn(async () => ({
      alias: 'new-model',
      value: {
        provider: 'openrouter',
        provider_model_id: 'vendor/new-model',
      },
    }));
    const res = await invoke(
      'POST',
      '/v1/model-registrations',
      {
        providerId: 'openrouter',
        providerModelId: 'vendor/new-model',
        alias: 'new-model',
        expectedRevision: 5,
      },
      context({ prepareRegistration }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      revision: 6,
      alias: 'new-model',
      providerId: 'openrouter',
      providerModelId: 'vendor/new-model',
    });
    expect(desiredStateWrites).toHaveLength(1);
    expect(desiredStateWrites[0]).toMatchObject({
      body: {
        expectedRevision: 5,
        settings: {
          model_aliases: {
            existing: { provider: 'provider-a' },
            'new-model': {
              provider: 'openrouter',
              provider_model_id: 'vendor/new-model',
            },
          },
        },
      },
    });
  });
});

function context(
  providerModels: Partial<NonNullable<ControlRouteContext['providerModels']>>,
): ControlRouteContext {
  return {
    keys: [
      {
        kid: 'admin',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(['agents:admin', 'sessions:read']),
        appId: 'default',
      },
    ],
    providerModels: {
      list: async () => {
        throw new Error('unexpected list');
      },
      prepareRegistration: async () => {
        throw new Error('unexpected registration');
      },
      ...providerModels,
    },
  } as ControlRouteContext;
}

async function invoke(
  method: string,
  pathname: string,
  body: unknown,
  ctx: ControlRouteContext,
): Promise<TestResponse> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  const res = {
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
  await handleModelRoutes(req, res, ctx, pathname.split('?', 1)[0]!);
  return res;
}
