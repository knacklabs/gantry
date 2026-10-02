import path from 'node:path';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createPostgresIntegrationRuntime,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import {
  reserveControlPort,
  startTestControlServer,
} from '../harness/control-http-server.js';

// Fix-owned proof: phone-users-can-t-open-the-web-console-b.
// The old shell refused phones; navigation must now work at the same boundary
// as desktop, with focus recovery and wide content contained in scroll areas.
describe('phone console navigation (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let api: Awaited<ReturnType<typeof startTestControlServer>>;
  let web: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let origin: string;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'phone_console',
    });
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    const { createDefaultRuntimeSettings, saveRuntimeSettings } =
      await import('@core/config/settings/runtime-settings.js');
    const port = await reserveControlPort();
    origin = `http://127.0.0.1:${port}`;
    const settings = createDefaultRuntimeSettings();
    settings.authentication.canonicalOrigin = origin;
    saveRuntimeSettings(process.env.GANTRY_HOME!, settings);
    api = await startTestControlServer({
      token: 'phone-console-test',
      appId: 'default',
      scopes: ['memory:read'],
    });
    vi.stubEnv('GANTRY_LOCAL_CORE_ORIGIN', api.baseUrl);
    web = await createServer({
      configFile: path.resolve('apps/web/vite.config.ts'),
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port, strictPort: true },
    });
    await web.listen();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 320, height: 640 } });
    page.setDefaultTimeout(5_000);
    const { createLocalAuthorizationUrl } =
      await import('@core/control/server/routes/browser-auth.js');
    await page.goto(
      await createLocalAuthorizationUrl({ canonicalOrigin: origin }),
    );
    await page.waitForURL(`${origin}/ui`);
    await page.goto(`${origin}/ui/profile`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await web?.close();
    await api?.close();
    await runtime?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);

  it('navigates at phone width with keyboard focus and contained wide tables', async () => {
    await expect.poll(() => page.locator('main').isVisible()).toBe(true);
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await menu.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Navigation' });
    await dialog.waitFor();
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await expect
      .poll(() =>
        menu.evaluate((element) => element === document.activeElement),
      )
      .toBe(true);
    expect(
      await menu.evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe('none');

    for (const [label, route] of [
      ['Profile', '/profile'],
      ['Authentication & Access', '/settings/authentication-access'],
      ['Jobs', '/jobs'],
    ] as const) {
      await menu.click();
      const link = dialog.getByRole('link', { name: label, exact: true });
      await link.focus();
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.pathname === `/ui${route}`);
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: label, exact: true }).waitFor();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }

    const table = page.getByRole('table');
    await table.waitFor();
    expect(
      await table.evaluate((element) => {
        const container = element.parentElement!;
        return (
          container.scrollWidth > container.clientWidth &&
          getComputedStyle(container).overflowX === 'auto'
        );
      }),
    ).toBe(true);
    await table.evaluate((element) => {
      element.parentElement!.scrollLeft = 200;
    });
    expect(
      await table.evaluate((element) => element.parentElement!.scrollLeft),
    ).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .waitFor();
    expect(await menu.isVisible()).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
