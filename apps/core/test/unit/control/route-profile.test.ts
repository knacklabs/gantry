import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Minimal storage stub so /readyz and /metrics (mounted in both profiles) can
// run without a real Postgres pool. This test asserts route MOUNTING per
// profile, not the internals of each route.
const pool = vi.hoisted(() => ({
  query: vi.fn(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('__drizzle_migrations')) {
      return { rows: [{ applied: 10_000 }] };
    }
    return { rows: [{ '?column?': 1 }] };
  }),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  tryAcquireRuntimeAdvisoryLease: vi.fn(async () => ({
    release: vi.fn(async () => {}),
  })),
  getRuntimeStorage: () => ({ service: { pool } }),
  getRuntimeRepositories: () => ({}),
  getRuntimeControlRepository: () => ({}),
}));

vi.mock('@core/runtime/settings-load-state.js', () => ({
  areSettingsLoaded: () => true,
}));

import { startTestControlServer } from '../../harness/control-http-server.js';

const TOKEN = 'route-profile-test-token-0123456789';
const APP_ID = 'default';

type Server = Awaited<ReturnType<typeof startTestControlServer>>;
let server: Server | undefined;
let uiDistDir: string | undefined;
let uiOutsidePath: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (uiDistDir) fs.rmSync(uiDistDir, { recursive: true, force: true });
  if (uiOutsidePath) fs.rmSync(uiOutsidePath, { force: true });
  uiDistDir = undefined;
  uiOutsidePath = undefined;
});

async function get(server: Server, path: string, withAuth = false) {
  return fetch(`${server.baseUrl}${path}`, {
    headers: withAuth ? { authorization: `Bearer ${server.token}` } : {},
  });
}

async function send(server: Server, method: string, path: string) {
  return fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
}

describe('control server route profile', () => {
  it('ops profile serves operational + read-only routes and 404s admin routes', async () => {
    server = await startTestControlServer({
      token: TOKEN,
      appId: APP_ID,
      scopes: ['agents:admin', 'sessions:read', 'jobs:write'],
      routeProfile: 'ops',
    });

    // Operational endpoints are served.
    expect((await get(server, '/healthz')).status).toBe(200);
    expect([200, 503]).toContain((await get(server, '/readyz')).status);
    expect((await get(server, '/metrics')).status).toBe(200);
    // Authenticated read-only diagnostics are served (not 404).
    expect((await get(server, '/v1/health', true)).status).not.toBe(404);
    // Live ingress aliases are mounted for the live-worker ALB target group.
    expect((await send(server, 'POST', '/webhooks/ingress-1')).status).toBe(
      400,
    );

    // Representative admin/mutation routes are unmounted → 404.
    expect(
      (await send(server, 'PUT', '/v1/settings/desired-state')).status,
    ).toBe(404);
    expect((await get(server, '/v1/agents', true)).status).toBe(404);
    expect((await send(server, 'POST', '/v1/jobs')).status).toBe(404);
  });

  it('full profile mounts admin routes (no blanket 404)', async () => {
    server = await startTestControlServer({
      token: TOKEN,
      appId: APP_ID,
      scopes: ['agents:admin', 'sessions:read', 'jobs:write'],
      routeProfile: 'full',
    });

    // Admin routes are mounted: they respond with their own status (auth/
    // validation/handler), never the unmounted-route 404 fallback.
    expect((await get(server, '/v1/agents', true)).status).not.toBe(404);
    expect(
      (await send(server, 'PUT', '/v1/settings/desired-state')).status,
    ).not.toBe(404);
    // Operational endpoints still work in full profile.
    expect((await get(server, '/healthz')).status).toBe(200);
  });

  it('defaults to full profile when routeProfile is omitted', async () => {
    server = await startTestControlServer({
      token: TOKEN,
      appId: APP_ID,
      scopes: ['agents:admin'],
    });

    expect((await get(server, '/v1/agents', true)).status).not.toBe(404);
  });

  it('serves the bundled UI only from the full profile', async () => {
    uiDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-ui-'));
    fs.writeFileSync(
      path.join(uiDistDir, 'index.html'),
      '<!doctype html><title>Gantry</title>',
    );
    uiOutsidePath = `${uiDistDir}.secret`;
    fs.writeFileSync(uiOutsidePath, 'secret');
    fs.mkdirSync(path.join(uiDistDir, 'assets'));
    fs.writeFileSync(
      path.join(uiDistDir, 'assets', 'app.js'),
      'console.log(1)',
    );

    server = await startTestControlServer({
      token: TOKEN,
      appId: APP_ID,
      scopes: ['agents:admin'],
      routeProfile: 'full',
      uiDistDir,
    });
    const page = await get(server, '/ui/auth/sign-in');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Gantry</title>');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const asset = await get(server, '/ui/assets/app.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(
      await (
        await get(server, `/ui/%2e%2e/${path.basename(uiOutsidePath)}`)
      ).text(),
    ).not.toContain('secret');
    await server.close();
    server = undefined;

    server = await startTestControlServer({
      token: TOKEN,
      appId: APP_ID,
      scopes: ['agents:admin'],
      routeProfile: 'ops',
      uiDistDir,
    });
    expect((await get(server, '/ui/')).status).toBe(404);
  });
});
