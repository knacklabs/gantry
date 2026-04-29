import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateBrowserCdpResponse } from '@core/runner/mcp/browser-cdp-health.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runner browser MCP tools', () => {
  it('leaves non-running browser status responses unchanged', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = {
      ok: true,
      data: { profileName: 'myclaw', running: false },
    };

    await expect(validateBrowserCdpResponse(response)).resolves.toBe(response);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts running browser responses with reachable CDP HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return { ok: true };
      }),
    );
    const response = {
      ok: true,
      data: { profileName: 'myclaw', running: true, port: 50601 },
    };

    await expect(validateBrowserCdpResponse(response)).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:50601/json/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fails closed when a running browser response points at stale CDP HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    await expect(
      validateBrowserCdpResponse({
        ok: true,
        data: { profileName: 'myclaw', running: true, port: 64561 },
      }),
    ).resolves.toEqual({
      ok: false,
      error:
        'Browser CDP endpoint 127.0.0.1:64561 is not reachable; the browser session is stale. Retry browser_launch.',
    });
  });
});
