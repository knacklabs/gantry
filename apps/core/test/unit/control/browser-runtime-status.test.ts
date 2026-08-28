import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, expect, it, vi } from 'vitest';

const activeSession = vi.hoisted(() => vi.fn());

vi.mock('@core/control/server/routes/browser-auth.js', () => ({
  activeSession,
}));

import {
  handleBrowserRuntimeStatus,
  isBrowserRuntimeStatusPath,
} from '@core/control/server/routes/browser-runtime-status.js';

function request() {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.headers = {};
  return req;
}

function response() {
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

beforeEach(() => {
  activeSession.mockReset();
});

it('returns a redacted authenticated runtime readiness signal', async () => {
  activeSession.mockResolvedValue({ userId: 'user:one' });
  const res = response();

  await handleBrowserRuntimeStatus(
    request(),
    res,
    { processRole: 'all' } as never,
    '/ui/api/runtime-status',
    { authentication: { mode: 'local' } },
  );

  expect(isBrowserRuntimeStatusPath('/ui/api/runtime-status')).toBe(true);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({
    status: 'connected',
    processRole: 'all',
  });
});

it('rejects an unavailable browser session', async () => {
  activeSession.mockResolvedValue(null);
  const unauthorized = response();
  await handleBrowserRuntimeStatus(
    request(),
    unauthorized,
    { processRole: 'all' } as never,
    '/ui/api/runtime-status',
    { authentication: { mode: 'local' } },
  );
  expect(unauthorized.statusCode).toBe(401);
});
