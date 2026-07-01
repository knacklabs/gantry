import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeRepository = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  listPeople: vi.fn(),
  getPerson: vi.fn(),
  addAlias: vi.fn(),
  retireAlias: vi.fn(),
  previewMerge: vi.fn(),
  mergePeople: vi.fn(),
}));

const runtimeEvents = vi.hoisted(() => ({
  publish: vi.fn(async () => ({ eventId: 1 })),
}));

vi.mock(
  '@core/adapters/storage/postgres/repositories/person-identity-repository.postgres.js',
  () => ({
    PostgresPersonIdentityRepository: class {
      resolveIdentity = fakeRepository.resolveIdentity;
      listPeople = fakeRepository.listPeople;
      getPerson = fakeRepository.getPerson;
      addAlias = fakeRepository.addAlias;
      retireAlias = fakeRepository.retireAlias;
      previewMerge = fakeRepository.previewMerge;
      mergePeople = fakeRepository.mergePeople;
    },
  }),
);

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ service: { db: {} } }),
  getRuntimeEventExchange: () => runtimeEvents,
}));

import { handlePeopleRoutes } from '@core/control/server/routes/people.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

function request(method: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(
    payload ? [Buffer.from(payload)] : [],
  ) as IncomingMessage;
  req.method = method;
  req.headers = {
    authorization: 'Bearer test-token',
    ...(payload ? { 'content-type': 'application/json' } : {}),
  };
  return req;
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

function ctx(
  scopes: string[] = ['identity:resolve', 'people:read', 'people:admin'],
) {
  return {
    keys: [
      {
        kid: 'test',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(scopes),
        appId: 'app-one',
      },
    ],
  } as unknown as ControlRouteContext;
}

async function call(input: {
  method: string;
  pathname: string;
  body?: unknown;
  query?: string;
  scopes?: string[];
}) {
  const res = responseRecorder();
  const url = new URL(
    `${input.pathname}${input.query ?? ''}`,
    'http://localhost',
  );
  await handlePeopleRoutes(
    request(input.method, input.body),
    res,
    ctx(input.scopes),
    url,
    input.pathname,
  );
  return { res, body: JSON.parse(res.body) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('people control routes', () => {
  it('resolves identity through the identity:resolve scope', async () => {
    fakeRepository.resolveIdentity.mockResolvedValue({
      status: 'created',
      personId: 'person-1',
      memoryHydrationEligible: true,
      verificationStatus: 'unverified',
    });

    const { res, body } = await call({
      method: 'POST',
      pathname: '/v1/identity/resolve',
      body: {
        provider: 'slack',
        externalUserId: 'U1',
        evidenceType: 'provider_user',
      },
      scopes: ['identity:resolve'],
    });

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: 'created',
      personId: 'person-1',
      memoryHydrationEligible: true,
    });
    expect(fakeRepository.resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-one', provider: 'slack' }),
    );
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'identity.resolved',
        payload: expect.objectContaining({
          provider: 'slack',
          evidenceType: 'provider_user',
          personId: 'person-1',
        }),
      }),
    );
  });

  it('accepts phone and web_user identity evidence without changing the wire shape', async () => {
    fakeRepository.resolveIdentity.mockResolvedValue({
      status: 'resolved',
      personId: 'person-2',
      memoryHydrationEligible: true,
      verificationStatus: 'verified',
    });

    const phone = await call({
      method: 'POST',
      pathname: '/v1/identity/resolve',
      body: {
        provider: 'phone',
        externalUserId: '+15551234567',
        evidenceType: 'phone',
      },
      scopes: ['identity:resolve'],
    });
    const webUser = await call({
      method: 'POST',
      pathname: '/v1/identity/resolve',
      body: {
        provider: 'app',
        externalUserId: 'sdk-user-1',
        evidenceType: 'web_user',
      },
      scopes: ['identity:resolve'],
    });

    expect(phone.res.statusCode).toBe(200);
    expect(webUser.res.statusCode).toBe(200);
    expect(fakeRepository.resolveIdentity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: 'phone',
        externalUserId: '+15551234567',
        evidenceType: 'phone',
      }),
    );
    expect(fakeRepository.resolveIdentity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'app',
        externalUserId: 'sdk-user-1',
        evidenceType: 'web_user',
      }),
    );
  });

  it('rejects cross-app people reads with the product error copy', async () => {
    const { res, body } = await call({
      method: 'GET',
      pathname: '/v1/people/person-1',
      query: '?appId=app-two',
      scopes: ['people:read'],
    });

    expect(res.statusCode).toBe(403);
    expect(body.error.message).toBe('Person is not accessible to this app.');
  });

  it('returns exact merge preview and apply summaries', async () => {
    fakeRepository.previewMerge.mockResolvedValue({
      summary: 'Merge preview only. No data changed.',
      sourcePersonId: 'person-source',
      targetPersonId: 'person-target',
      aliasesToMove: [],
      memoryRowsToMove: 0,
      excludedMemoryScopes: { group: 0, channel: 0, common: 0 },
      conflicts: [],
    });
    fakeRepository.mergePeople.mockResolvedValue({
      summary:
        'Person merge completed. Personal memory and aliases now belong to the target person.',
      sourcePersonId: 'person-source',
      targetPersonId: 'person-target',
      aliasesToMove: [],
      memoryRowsToMove: 0,
      excludedMemoryScopes: { group: 0, channel: 0, common: 0 },
      conflicts: [],
      idempotencyKey: 'merge-1',
      auditId: 'audit-1',
      applied: true,
    });

    const preview = await call({
      method: 'POST',
      pathname: '/v1/people/person-target/merge:preview',
      body: { sourcePersonId: 'person-source' },
      scopes: ['people:admin'],
    });
    const apply = await call({
      method: 'POST',
      pathname: '/v1/people/person-target/merge',
      body: { sourcePersonId: 'person-source', idempotencyKey: 'merge-1' },
      scopes: ['people:admin'],
    });

    expect(preview.body.summary).toBe('Merge preview only. No data changed.');
    expect(apply.body.summary).toBe(
      'Person merge completed. Personal memory and aliases now belong to the target person.',
    );
  });

  it('publishes alias admin events without raw alias values', async () => {
    fakeRepository.addAlias.mockResolvedValue({
      id: 'alias-1',
      appId: 'app-one',
      personId: 'person-1',
      provider: 'slack',
      providerConnectionId: 'providerConnection-slack',
      externalUserId: 'U123',
      verificationStatus: 'verified',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    fakeRepository.retireAlias.mockResolvedValue({
      id: 'alias-1',
      appId: 'app-one',
      personId: 'person-1',
      provider: 'slack',
      providerConnectionId: 'providerConnection-slack',
      externalUserId: 'U123',
      verificationStatus: 'retired',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const add = await call({
      method: 'POST',
      pathname: '/v1/people/person-1/aliases',
      body: {
        provider: 'slack',
        providerConnectionId: 'providerConnection-slack',
        externalUserId: 'U123',
        evidenceType: 'provider_user',
      },
      scopes: ['people:admin'],
    });
    const retire = await call({
      method: 'DELETE',
      pathname: '/v1/people/person-1/aliases/alias-1',
      scopes: ['people:admin'],
    });

    expect(add.res.statusCode).toBe(201);
    expect(retire.res.statusCode).toBe(200);
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'identity.alias.linked',
        payload: expect.objectContaining({
          personId: 'person-1',
          aliasId: 'alias-1',
          provider: 'slack',
          providerConnectionId: 'providerConnection-slack',
        }),
      }),
    );
    expect(runtimeEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'identity.alias.retired',
        payload: expect.objectContaining({
          personId: 'person-1',
          aliasId: 'alias-1',
          provider: 'slack',
          providerConnectionId: 'providerConnection-slack',
        }),
      }),
    );
    const publishedPayloads = runtimeEvents.publish.mock.calls.map(
      (call) => call[0].payload,
    );
    expect(JSON.stringify(publishedPayloads)).not.toContain('U123');
  });
});
