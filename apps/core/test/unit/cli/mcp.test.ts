import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let server: http.Server | null = null;
const originalEnv = { ...process.env };

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-mcp-cli-'));
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
  it('connects MCP servers through the control API only', async () => {
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
        const body = Buffer.concat(chunks).toString('utf-8');
        seen.push({
          method: req.method,
          url: req.url,
          body: body ? JSON.parse(body) : undefined,
        });
        if (req.method === 'POST' && req.url === '/v1/mcp-servers') {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ server: { id: 'mcp:one', status: 'active' } }),
          );
          return;
        }
        if (
          req.method === 'PUT' &&
          req.url === '/v1/agents/agent%3Amain/mcp-servers/mcp%3Aone'
        ) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ binding: { status: 'active' } }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unexpected route' } }));
      });
    });
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'cli-test',
        token: 'test-key',
        appId: 'default',
        scopes: ['mcp:admin'],
      },
    ]);
    process.env.GANTRY_CONTROL_PORT = String(port);

    const { runMcpCommand } = await import('@core/cli/mcp.js');
    const code = await runMcpCommand(makeTempDir(), [
      'connect',
      '--name',
      'github',
      '--transport',
      'stdio_template',
      '--template',
      'npx-package',
      '--arg',
      '@modelcontextprotocol/server-github',
      '--sandbox-profile',
      'mcp-stdio',
      '--agent',
      'main',
      '--tool',
      'search_repositories',
      '--credential',
      'github_token:env:GITHUB_TOKEN',
    ]);

    expect(code).toBe(0);
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/mcp-servers',
        body: expect.objectContaining({
          name: 'github',
          transport: 'stdio_template',
          config: {
            transport: 'stdio_template',
            templateId: 'npx-package',
            args: ['@modelcontextprotocol/server-github'],
          },
          sandboxProfileId: 'mcp-stdio',
          allowedToolPatterns: ['search_repositories'],
          credentialRefs: [
            {
              name: 'github_token',
              target: 'env',
              key: 'GITHUB_TOKEN',
            },
          ],
        }),
      },
      {
        method: 'PUT',
        url: '/v1/agents/agent%3Amain/mcp-servers/mcp%3Aone',
        body: { permissionPolicyIds: [] },
      },
    ]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('server: mcp:one'),
      'MCP Connected',
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
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'cli-test',
        token: 'test-key',
        appId: 'default',
        scopes: ['mcp:read'],
      },
    ]);
    process.env.GANTRY_CONTROL_BASE_URL = `http://127.0.0.1:${port}`;
    delete process.env.GANTRY_CONTROL_PORT;

    const { runMcpCommand } = await import('@core/cli/mcp.js');
    const code = await runMcpCommand(makeTempDir(), ['list']);

    expect(code).toBe(0);
    expect(seen).toEqual([{ method: 'GET', url: '/v1/mcp-servers' }]);
    expect(note).toHaveBeenCalledWith('No records found.', 'MCP Servers');
  });
});
