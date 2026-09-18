import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Route } from 'playwright-core';
import { resolvePublicEgressAddress } from '@core/shared/egress-target-resolution.js';

vi.mock('@core/shared/egress-target-resolution.js', () => ({
  resolvePublicEgressAddress: vi.fn(async () => ({ ok: true })),
}));

import {
  browserNavigationHostAllowed,
  installBrowserContextNetworkPolicy,
} from '@core/runtime/browser-network-policy.js';

describe('browser network policy', () => {
  it('enforces GET/HEAD-approved origins on browser subresources and form requests', async () => {
    let guard: ((route: Route) => Promise<void>) | undefined;
    await installBrowserContextNetworkPolicy({
      context: {
        route: async (_pattern, handler) => {
          guard = handler;
        },
      } as unknown as BrowserContext,
      allowedHosts: [],
      allowedOrigins: ['https://method.example.test'],
      allowedMethodsByOrigin: {
        'https://method.example.test': ['GET', 'HEAD'],
      },
    });
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
      const route = {
        request: () => ({
          url: () => 'https://method.example.test/data',
          method: () => method,
          isNavigationRequest: () => false,
        }),
        abort: vi.fn(async () => undefined),
        continue: vi.fn(async () => undefined),
      };
      await guard!(route as unknown as Route);
      expect(route.continue).toHaveBeenCalledTimes(
        ['GET', 'HEAD'].includes(method) ? 1 : 0,
      );
      expect(route.abort).toHaveBeenCalledTimes(
        ['GET', 'HEAD'].includes(method) ? 0 : 1,
      );
    }
  });
  it('enforces exact validation origins on subresources as well as navigation', async () => {
    let guard: ((route: Route) => Promise<void>) | undefined;
    const context = {
      route: async (
        _pattern: string,
        handler: (route: Route) => Promise<void>,
      ) => {
        guard = handler;
      },
    };
    await installBrowserContextNetworkPolicy({
      context: context as unknown as BrowserContext,
      allowedHosts: [],
      allowedOrigins: ['https://validation.example.gov'],
    });
    const credentialUrl = new URL('https://validation.example.gov/api');
    credentialUrl.username = 'test-only-user';
    credentialUrl.password = 'synthetic-fixture-only';
    for (const [url, allowed] of [
      ['https://validation.example.gov/script.js', true],
      ['https://validation.example.gov:443/api', true],
      ['http://validation.example.gov/api', false],
      ['https://validation.example.gov:8443/api', false],
      ['https://other.example.gov/file.pdf', false],
      [credentialUrl.href, false],
    ] as const) {
      for (const navigation of [false, true]) {
        vi.mocked(resolvePublicEgressAddress).mockClear();
        const route = {
          request: () => ({
            url: () => url,
            isNavigationRequest: () => navigation,
          }),
          abort: vi.fn(async () => undefined),
          continue: vi.fn(async () => undefined),
        };
        await guard!(route as unknown as Route);
        if (!allowed) expect(resolvePublicEgressAddress).not.toHaveBeenCalled();
        expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(route.abort).toHaveBeenCalledTimes(allowed ? 0 : 1);
      }
    }
  });
  it('allows only exact or explicitly wildcarded recipe navigation hosts', () => {
    const allowed = ['tenders.example.gov', '*.documents.example.gov'];
    expect(browserNavigationHostAllowed('tenders.example.gov', allowed)).toBe(
      true,
    );
    expect(
      browserNavigationHostAllowed('cdn.documents.example.gov', allowed),
    ).toBe(true);
    expect(browserNavigationHostAllowed('example.gov', allowed)).toBe(false);
    expect(
      browserNavigationHostAllowed('tenders.example.gov.evil.test', allowed),
    ).toBe(false);
  });

  it('allows recipe authoring to discover another public navigation host', () => {
    expect(
      browserNavigationHostAllowed('www.example.gov', ['example.gov'], true),
    ).toBe(true);
  });
});
