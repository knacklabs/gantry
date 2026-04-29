import http from 'http';
import { describe, expect, it } from 'vitest';

import { validateBrowserCdpResponse } from '@core/runner/mcp/browser-cdp-health.js';

describe('runner browser MCP tools', () => {
  it('leaves non-running browser status responses unchanged', async () => {
    const response = {
      ok: true,
      data: { profileName: 'myclaw', running: false },
    };

    await expect(validateBrowserCdpResponse(response)).resolves.toBe(response);
  });

  it('accepts running browser responses with reachable CDP HTTP', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected test HTTP server address');
      }
      const response = {
        ok: true,
        data: { profileName: 'myclaw', running: true, port: address.port },
      };

      await expect(validateBrowserCdpResponse(response)).resolves.toBe(response);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('fails closed when a running browser response points at stale CDP HTTP', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test HTTP server address');
    }
    const port = address.port;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    await expect(
      validateBrowserCdpResponse({
        ok: true,
        data: { profileName: 'myclaw', running: true, port },
      }),
    ).resolves.toEqual({
      ok: false,
      error: `Browser CDP endpoint 127.0.0.1:${port} is not reachable; the browser session is stale. Retry browser_launch.`,
    });
  });
});
