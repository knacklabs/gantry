import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];
let server: http.Server | null = null;
const originalEnv = { ...process.env };

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-skill-cli-'));
  tempDirs.push(dir);
  return dir;
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
  process.env = { ...originalEnv };
  const existing = server;
  server = null;
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.close((error) => (error ? reject(error) : resolve()));
    });
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('skill CLI', () => {
  it('installs a skill zip through the control API without touching .claude skills', async () => {
    const runtimeHome = makeTempDir();
    const zipPath = path.join(makeTempDir(), 'skill.zip');
    fs.writeFileSync(zipPath, Buffer.from([1, 2, 3]));
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const seen: Array<{
      method?: string;
      url?: string;
      contentType?: string | string[];
      body: number[];
    }> = [];
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          contentType: req.headers['content-type'],
          body: [...Buffer.concat(chunks)],
        });
        res.writeHead(req.method === 'POST' ? 201 : 200, {
          'content-type': 'application/json',
        });
        if (req.method === 'POST') {
          res.end(
            JSON.stringify({
              skill: { id: 'skill:one', name: 'Uploaded', status: 'installed' },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ binding: { status: 'active' } }));
      });
    });
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'cli-test',
        token: 'test-key',
        appId: 'default',
        scopes: ['skills:admin'],
      },
    ]);
    process.env.GANTRY_CONTROL_PORT = String(port);

    const { runSkillCommand } = await import('@core/cli/skills.js');
    const code = await runSkillCommand(runtimeHome, [
      'install',
      zipPath,
      '--agent',
      'agent:one',
      '--created-by',
      'admin',
    ]);

    expect(code).toBe(0);
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/skills/install?agentId=agent%3Aone&createdBy=admin',
        contentType: 'application/zip',
        body: [1, 2, 3],
      },
      {
        method: 'PUT',
        url: '/v1/agents/agent%3Aone/skills/skill%3Aone',
        contentType: 'application/json',
        body: [123, 125],
      },
    ]);
    expect(fs.existsSync(path.join(runtimeHome, '.claude', 'skills'))).toBe(
      false,
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('skill:one'),
      'Skill Installed',
    );
  });

  it('installs a skill for an agent in one command', async () => {
    const runtimeHome = makeTempDir();
    const zipPath = path.join(makeTempDir(), 'skill.zip');
    fs.writeFileSync(zipPath, Buffer.from([4, 5, 6]));
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        seen.push({ method: req.method, url: req.url, body });
        if (req.url?.startsWith('/v1/skills/install')) {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              skill: {
                id: 'skill:installed',
                actionPermissions: [
                  { capabilityId: 'skill.linkedin-posting.publish' },
                ],
              },
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (
          req.url === '/v1/agents/agent%3Amain_agent/skills/skill%3Ainstalled'
        ) {
          res.end(JSON.stringify({ binding: { status: 'active' } }));
          return;
        }
        if (
          req.method === 'GET' &&
          req.url === '/v1/agents/agent%3Amain_agent/capabilities'
        ) {
          res.end(
            JSON.stringify({
              capabilities: [{ id: 'browser.use', version: 'builtin' }],
            }),
          );
          return;
        }
        if (
          req.method === 'PUT' &&
          req.url === '/v1/agents/agent%3Amain_agent/capabilities'
        ) {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'unexpected route' } }));
      });
    });
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'cli-test',
        token: 'test-key',
        appId: 'default',
        scopes: ['skills:admin', 'agents:admin'],
      },
    ]);
    process.env.GANTRY_CONTROL_PORT = String(port);

    const { runSkillCommand } = await import('@core/cli/skills.js');
    const code = await runSkillCommand(runtimeHome, [
      'install',
      zipPath,
      '--agent',
      'main_agent',
    ]);

    expect(code).toBe(0);
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /v1/skills/install?agentId=agent%3Amain_agent&createdBy=cli',
      'PUT /v1/agents/agent%3Amain_agent/skills/skill%3Ainstalled',
      'GET /v1/agents/agent%3Amain_agent/capabilities',
      'PUT /v1/agents/agent%3Amain_agent/capabilities',
    ]);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      capabilities: [
        { id: 'browser.use', version: 'builtin' },
        { id: 'skill.linkedin-posting.publish', version: 'builtin' },
      ],
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('skill.linkedin-posting.publish'),
      'Skill Installed',
    );
  });
});
