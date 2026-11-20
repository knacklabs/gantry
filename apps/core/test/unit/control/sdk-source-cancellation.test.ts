import http from 'node:http';
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { GantryClient } from '../../../../../packages/sdk/src/index.js';
async function fixture(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Fixture absent');
  return {
    client: new GantryClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'fixture',
      timeoutMs: 10000,
    }),
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function bounded<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Error('Request remained pending past fixture deadline')),
        750,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
describe('SDK JSON request cancellation', () => {
  it('rejects a pre-aborted JSON request without writing HTTP bytes', async () => {
    const f = await fixture((_req, res) => res.end('{}'));
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(
        bounded(
          f.client.request({
            method: 'POST',
            path: '/fixture',
            body: { exact: 'payload' },
            signal: abort.signal,
          }),
        ),
      ).rejects.toThrow(/abort/i);
      expect(f.requests()).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('removes its abort subscription after a successful JSON response', async () => {
    const f = await fixture((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    try {
      const abort = new AbortController();
      expect(
        await f.client.request({
          method: 'POST',
          path: '/fixture',
          body: { exact: 'payload' },
          signal: abort.signal,
        }),
      ).toEqual({ ok: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('cancels a trickling response and closes the connection', async () => {
    let closed = false;
    const f = await fixture((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        const timer = setInterval(() => res.write(' '), 10);
        res.on('close', () => {
          closed = true;
          clearInterval(timer);
        });
      });
    });
    try {
      const signal = AbortSignal.timeout(80);
      await expect(
        bounded(
          f.client.request({
            method: 'POST',
            path: '/fixture',
            body: { exact: 'payload' },
            signal,
          }),
        ),
      ).rejects.toThrow(/abort|timeout/i);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(true);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('passes the same signal through session ensure and source append', async () => {
    const abort = new AbortController();
    const f = await fixture((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    try {
      abort.abort();
      await expect(
        bounded(
          f.client.sessions.ensure(
            { appId: 'app', conversationId: 'D' },
            { signal: abort.signal },
          ),
        ),
      ).rejects.toThrow(/abort/i);
      await expect(
        bounded(
          f.client.sessions.appendSourceMessage('S', {} as never, {
            signal: abort.signal,
          }),
        ),
      ).rejects.toThrow(/abort/i);
      expect(f.requests()).toBe(0);
    } finally {
      await f.close();
    }
  });
});
