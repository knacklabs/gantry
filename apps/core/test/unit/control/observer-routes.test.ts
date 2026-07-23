import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      observerInsights: {
        count: vi.fn(async (input: { state?: string }) =>
          input.state === 'pending' ? 2 : 5,
        ),
      },
    },
  }),
}));

vi.mock('@core/brain/brain-runtime.js', () => ({
  createRuntimeBrainService: () => ({
    status: vi.fn(async () => ({ channelPages: 3 })),
  }),
}));

import { handleObserverRoutes } from '@core/control/server/routes/observer.js';

it('keeps the observer status response shape while resolving activation through the port', async () => {
  const resolveObserverStatus = vi.fn(async () => ({
    enabled: true,
    activation: 'active' as const,
    message: 'Observer is active.',
    dreamingEnabled: true,
    owner: {
      recipient: 'user-1',
      conversation: 'owner_dm',
      conversationJid: 'cp:room-1',
      providerAccountId: 'account_1',
    },
  }));
  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  } as IncomingMessage;
  const res = responseRecorder();
  const ctx = {
    keys: [
      {
        kid: 'test',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(['memory:read']),
        appId: 'default',
      },
    ],
    resolveObserverStatus,
  } as ControlRouteContext;

  await expect(
    handleObserverRoutes(
      req,
      res,
      ctx,
      new URL('http://localhost/v1/observer/status'),
      '/v1/observer/status',
    ),
  ).resolves.toBe(true);

  expect(res.statusCode).toBe(200);
  expect(res.body).toBe(
    `${JSON.stringify({
      enabled: true,
      activation: 'active',
      message: 'Observer is active.',
      dreamingEnabled: true,
      owner: {
        recipient: 'user-1',
        conversation: 'owner_dm',
        conversationJid: 'cp:room-1',
        providerAccountId: 'account_1',
      },
      counts: { evidence: 3, insights: 5, pendingInsights: 2 },
    })}\n`,
  );
  expect(resolveObserverStatus).toHaveBeenCalledWith('default');
});

function responseRecorder(): ServerResponse & { body: string } {
  return {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as unknown as ServerResponse & { body: string };
}
