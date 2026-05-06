import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGuardedMcpFetch } from '@core/application/mcp/mcp-tool-proxy.js';

describe('createGuardedMcpFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects hostname fetches until MCP proxy has DNS-pinned transport', async () => {
    const lookupHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      createGuardedMcpFetch({ lookupHostname })(
        'https://mcp.example.test/tools',
      ),
    ).rejects.toThrow('DNS-pinned transport');

    expect(lookupHostname).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows public IP-literal URLs through public-address validation', async () => {
    const lookupHostname = vi.fn();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await createGuardedMcpFetch({ lookupHostname })(
      'https://93.184.216.34/tools',
    );

    expect(lookupHostname).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://93.184.216.34/tools',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
