import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { startHttpServer, type RunningHttpServer } from '../../src/server.js';
import { createLogger } from '../../src/logger.js';
import type { ShopifyMcpEnv } from '../../src/env.js';

let running: RunningHttpServer | undefined;

function env(port: number): ShopifyMcpEnv {
  return {
    mode: 'dev',
    shopDomain: 'test-shop.myshopify.com',
    clientId: 'test_id',
    clientSecret: 'test_secret',
    apiVersion: '2026-04',
    port,
    refreshLeadTimeMs: 300_000,
    logLevel: 'error',
    logFormat: 'json',
    identity: { mode: 'disabled' },
    requireVerifiedIdentity: false,
    identityMaxAgeSec: 60,
    identityCacheTtlMs: 0,
    productSearchCacheTtlMs: 0,
    productSearchCacheRefreshLeadMs: 0,
  };
}

async function boot(port: number): Promise<void> {
  running = await startHttpServer({
    env: env(port),
    logger: createLogger({ level: 'error', format: 'json' }),
  });
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('Shopify MCP /healthz', () => {
  it('responds 200 with JSON {ok:true}', async () => {
    const port = 18184;
    await boot(port);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('normalizes a trailing slash (/healthz/)', async () => {
    const port = 18185;
    await boot(port);
    const res = await fetch(`http://127.0.0.1:${port}/healthz/`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown, non-mcp paths', async () => {
    const port = 18186;
    await boot(port);
    const res = await fetch(`http://127.0.0.1:${port}/not-a-route`);
    expect(res.status).toBe(404);
  });

  it('rejects cleanly when the configured port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') {
      blocker.close();
      throw new Error('No TCP port assigned');
    }

    try {
      await expect(
        startHttpServer({
          env: env(address.port),
          logger: createLogger({ level: 'error', format: 'json' }),
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
