import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';

const databaseDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

databaseDescribe('account owner identity', () => {
  let runtime: PostgresIntegrationRuntime;
  let server: { baseUrl: string; close(): Promise<void> };
  let browser: Browser;
  let runtimeApp: import('@core/app/bootstrap/runtime-app.js').RuntimeApp;
  let home: string;
  const previousHome = process.env.GANTRY_HOME;
  const previousDatabaseUrl = process.env.GANTRY_DATABASE_URL;
  const previousEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-account-owners-'));
    process.env.GANTRY_HOME = home;
    process.env.GANTRY_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;
    process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    vi.resetModules();
    const { createPostgresIntegrationRuntime } =
      await import('../harness/postgres-integration-runtime.js');
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'account_owner_identity',
    });
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    execFileSync('npm', ['run', 'build', '--workspace', '@gantry/web'], {
      stdio: 'pipe',
    });
    const { startTestControlServer } =
      await import('../harness/control-http-server.js');
    const { createRuntimeApp } =
      await import('@core/app/bootstrap/runtime-app.js');
    runtimeApp = createRuntimeApp();
    server = await startTestControlServer({
      token: 'account-owner-test',
      appId: 'default',
      scopes: ['agents:admin', 'providers:admin'],
      uiDistDir: path.resolve('apps/web/dist'),
      runtimeApp,
    });
    const { createDefaultRuntimeSettings, saveRuntimeSettings } =
      await import('@core/config/settings/runtime-settings.js');
    const settings = createDefaultRuntimeSettings();
    settings.authentication.canonicalOrigin = server.baseUrl;
    saveRuntimeSettings(home, settings);
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await runtimeApp?.queue.shutdown(0);
    await runtime?.cleanup();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.GANTRY_HOME;
    else process.env.GANTRY_HOME = previousHome;
    if (previousDatabaseUrl === undefined)
      delete process.env.GANTRY_DATABASE_URL;
    else process.env.GANTRY_DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined)
      delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = previousEncryptionKey;
  }, 60_000);

  it('shows and links every account owner regardless of directory page', async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.setDefaultTimeout(10_000);
    const { createLocalAuthorizationUrl } =
      await import('@core/control/server/routes/browser-auth.js');
    await page.goto(
      await createLocalAuthorizationUrl({ canonicalOrigin: server.baseUrl }),
    );
    await page.waitForURL(`${server.baseUrl}/ui/`);
    const csrf = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'gantry_csrf',
    )!.value;
    const headers = { origin: server.baseUrl, 'x-csrf-token': csrf };
    const owners: Array<{ id: string; name: string; accountId: string }> = [];
    for (let index = 0; index < 102; index++) {
      const name = `Employee ${String(index).padStart(3, '0')}`;
      const response = await page.request.post(
        `${server.baseUrl}/ui/api/agents`,
        {
          headers,
          data: { name },
        },
      );
      expect(response.status(), await response.text()).toBe(201);
      const { agent } = await response.json();
      if (index === 0 || index >= 100) {
        const accountResponse = await page.request.post(
          `${server.baseUrl}/ui/api/channel-accounts`,
          {
            headers,
            data: {
              agentId: agent.id,
              providerId: 'telegram',
              label: `Account ${index}`,
              credentials: { bot_token: 'test-only-token' },
            },
          },
        );
        expect(accountResponse.status(), await accountResponse.text()).toBe(
          201,
        );
        const { account } = await accountResponse.json();
        owners.push({ id: agent.id, name, accountId: account.id });
      }
    }
    const directory = await page.request.get(
      `${server.baseUrl}/ui/api/agents?page=1&pageSize=100&sort=name`,
    );
    const firstPage = await directory.json();
    expect(firstPage.data).toHaveLength(100);
    expect(
      firstPage.data.some((agent: { id: string }) => agent.id === owners[1].id),
    ).toBe(false);

    await page.goto(`${server.baseUrl}/ui/channel-accounts`);
    for (const owner of owners) {
      const link = page.getByRole('link', { name: owner.name, exact: true });
      await link.waitFor({ state: 'visible' });
      expect(await link.getAttribute('href')).toContain(
        `/agents/${encodeURIComponent(owner.id)}`,
      );
    }
    for (const owner of owners) {
      await page.goto(
        `${server.baseUrl}/ui/channel-accounts/${owner.accountId}`,
      );
      const link = page.getByRole('link', {
        name: `Open ${owner.name}`,
        exact: true,
      });
      await link.waitFor({ state: 'visible' });
      expect(await link.getAttribute('href')).toContain(
        `/agents/${encodeURIComponent(owner.id)}`,
      );
    }
    await page.request.dispose();
    await page.close();
  }, 300_000);
});
