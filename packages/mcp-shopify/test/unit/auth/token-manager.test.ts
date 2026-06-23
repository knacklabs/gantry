import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenManager } from '../../../src/auth/token-manager.js';
import { ShopifyAdapterError } from '../../../src/errors.js';

interface FetchCall {
  url: string;
}

function makeFetch(responses: Array<Response | (() => Response)>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (input: string | URL) => {
    calls.push({ url: input.toString() });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === 'function' ? r() : r;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TokenManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lazily fetches a token on first getToken()', async () => {
    const { fn, calls } = makeFetch([
      jsonResponse({ access_token: 'shpat_abc', expires_in: 3600 }),
    ]);
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      now: () => 1_000_000,
    });
    const token = await mgr.getToken();
    expect(token).toBe('shpat_abc');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/admin/oauth/access_token');
    expect(calls[0].url).toContain('grant_type=client_credentials');
    mgr.stop();
  });

  it('caches the token until refresh window opens', async () => {
    const { fn } = makeFetch([
      jsonResponse({ access_token: 'shpat_a', expires_in: 3600 }),
      jsonResponse({ access_token: 'shpat_b', expires_in: 3600 }),
    ]);
    let now = 1_000_000;
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      refreshLeadTimeMs: 60_000,
      now: () => now,
    });
    const a = await mgr.getToken();
    now += 1000;
    const b = await mgr.getToken();
    expect(a).toBe('shpat_a');
    expect(b).toBe('shpat_a');
    expect(fn).toHaveBeenCalledTimes(1);
    mgr.stop();
  });

  it('refreshes once expiry window opens', async () => {
    const { fn } = makeFetch([
      jsonResponse({ access_token: 'shpat_a', expires_in: 60 }),
      jsonResponse({ access_token: 'shpat_b', expires_in: 60 }),
    ]);
    let now = 1_000_000;
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      refreshLeadTimeMs: 5_000,
      now: () => now,
    });
    await mgr.getToken();
    now += 120_000;
    const next = await mgr.getToken();
    expect(next).toBe('shpat_b');
    expect(fn).toHaveBeenCalledTimes(2);
    mgr.stop();
  });

  it('forceRefresh acquires a new token immediately', async () => {
    const { fn } = makeFetch([
      jsonResponse({ access_token: 'shpat_a', expires_in: 3600 }),
      jsonResponse({ access_token: 'shpat_b', expires_in: 3600 }),
    ]);
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      now: () => 1_000_000,
    });
    await mgr.getToken();
    const refreshed = await mgr.forceRefresh();
    expect(refreshed).toBe('shpat_b');
    expect(fn).toHaveBeenCalledTimes(2);
    mgr.stop();
  });

  it('rejects with INVALID_CREDENTIALS on 401', async () => {
    const { fn } = makeFetch([jsonResponse({ error: 'unauthorized' }, 401)]);
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      now: () => 1_000_000,
    });
    await expect(mgr.getToken()).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    mgr.stop();
  });

  it('rejects with UNAVAILABLE on 5xx', async () => {
    const { fn } = makeFetch([jsonResponse({}, 502)]);
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      now: () => 1_000_000,
    });
    await expect(mgr.getToken()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    mgr.stop();
  });

  it('rejects with INVALID_REQUEST when token endpoint returns invalid JSON', async () => {
    const { fn } = makeFetch([
      new Response('{bad json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      now: () => 1_000_000,
    });

    await expect(mgr.getToken()).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    mgr.stop();
  });

  it('coalesces concurrent in-flight refreshes', async () => {
    let resolveOnce: ((value: Response) => void) | null = null;
    const fn = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolveOnce = resolve;
        }),
    ) as unknown as typeof fetch;
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      now: () => 1_000_000,
    });
    const a = mgr.getToken();
    const b = mgr.getToken();
    expect(fn).toHaveBeenCalledTimes(1);
    resolveOnce!(jsonResponse({ access_token: 'shpat_a', expires_in: 3600 }));
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toBe('shpat_a');
    expect(resB).toBe('shpat_a');
    mgr.stop();
  });

  it('throws NETWORK_ERROR when fetch rejects', async () => {
    const fn = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const mgr = new TokenManager({
      shopDomain: 'shop.myshopify.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: fn,
      now: () => 1_000_000,
    });
    await expect(mgr.getToken()).rejects.toBeInstanceOf(ShopifyAdapterError);
    await expect(mgr.getToken()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    mgr.stop();
  });
});
