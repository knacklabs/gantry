import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let server: http.Server | null = null;
const originalEnv = { ...process.env };

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-mcp-cli-'));
}

function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind test server'));
        return;
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  process.env = { ...originalEnv };
  const existing = server;
  server = null;
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe('mcp CLI', () => {
  it('creates MCP drafts through the control API only', async () => {
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    }));
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ server: { id: 'mcp:one', status: 'draft' } }));
      });
    });
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'cli-test',
        token: 'test-key',
        appId: 'default',
        scopes: ['mcp:admin'],
      },
    ]);
    process.env.MYCLAW_CONTROL_PORT = String(port);

    const { runMcpCommand } = await import('@core/cli/mcp.js');
    const code = await runMcpCommand(makeTempDir(), [
      'draft',
      'create',
      '--name',
      'github',
      '--transport',
      'http',
      '--url',
      'https://mcp.example.test/github',
      '--tool',
      'search_repositories',
      '--credential',
      'github_token:header:Authorization',
    ]);

    expect(code).toBe(0);
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/mcp-servers/drafts',
        body: expect.objectContaining({
          name: 'github',
          transport: 'http',
          config: {
            transport: 'http',
            url: 'https://mcp.example.test/github',
          },
          allowedToolPatterns: ['search_repositories'],
          credentialRefs: [
            {
              name: 'github_token',
              target: 'header',
              key: 'Authorization',
            },
          ],
        }),
      },
    ]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('"mcp:one"'),
      'MCP Draft Created',
    );
  });

  it('uses the configured control base URL instead of the local socket', async () => {
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    }));
    const seen: Array<{ method?: string; url?: string }> = [];
    const port = await listen((req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ servers: [] }));
    });
    process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'cli-test',
        token: 'test-key',
        appId: 'default',
        scopes: ['mcp:read'],
      },
    ]);
    process.env.MYCLAW_CONTROL_BASE_URL = `http://127.0.0.1:${port}`;
    delete process.env.MYCLAW_CONTROL_PORT;

    const { runMcpCommand } = await import('@core/cli/mcp.js');
    const code = await runMcpCommand(makeTempDir(), ['list']);

    expect(code).toBe(0);
    expect(seen).toEqual([{ method: 'GET', url: '/v1/mcp-servers' }]);
    expect(note).toHaveBeenCalledWith('(none)', 'MCP Servers');
  });
});
