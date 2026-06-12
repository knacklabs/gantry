import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-control-cli-'));
  tempDirs.push(dir);
  return dir;
}

async function withControlServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate test control server port');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('control API CLI client auth', () => {
  it('uses the first configured GANTRY_CONTROL_API_KEYS_JSON token as the bearer token', async () => {
    const runtimeHome = makeTempDir();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        `GANTRY_CONTROL_API_KEYS_JSON=${JSON.stringify([
          {
            kid: 'k1',
            token: 'json-token',
            appId: 'app-one',
            scopes: ['sessions:read'],
          },
        ])}`,
      ].join('\n'),
    );

    await withControlServer(
      (req, res) => {
        expect(req.headers.authorization).toBe('Bearer json-token');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      async (baseUrl) => {
        process.env.GANTRY_CONTROL_BASE_URL = baseUrl;
        const { controlApiRequest } = await import('@core/cli/control-api.js');

        await expect(
          controlApiRequest(runtimeHome, {
            method: 'GET',
            path: '/v1/sessions',
          }),
        ).resolves.toEqual({ ok: true });
      },
    );
  });

  it('reads JSON-quoted GANTRY_CONTROL_API_KEYS_JSON values from runtime .env', async () => {
    const runtimeHome = makeTempDir();
    const controlKeysJson = JSON.stringify([
      {
        kid: 'k1',
        token: 'json-token',
        appId: 'app-one',
        scopes: ['sessions:read'],
      },
    ]);
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      `GANTRY_CONTROL_API_KEYS_JSON=${JSON.stringify(controlKeysJson)}\n`,
    );

    await withControlServer(
      (req, res) => {
        expect(req.headers.authorization).toBe('Bearer json-token');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      async (baseUrl) => {
        process.env.GANTRY_CONTROL_BASE_URL = baseUrl;
        const { controlApiRequest } = await import('@core/cli/control-api.js');

        await expect(
          controlApiRequest(runtimeHome, {
            method: 'GET',
            path: '/v1/sessions',
          }),
        ).resolves.toEqual({ ok: true });
      },
    );
  });

  it('ignores GANTRY_CONTROL_API_KEY when JSON tokens are present', async () => {
    process.env.GANTRY_CONTROL_API_KEY = 'legacy-token';
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'k1',
        token: 'json-token',
        appId: 'app-one',
        scopes: ['sessions:read'],
      },
    ]);

    await withControlServer(
      (req, res) => {
        expect(req.headers.authorization).toBe('Bearer json-token');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      async (baseUrl) => {
        process.env.GANTRY_CONTROL_BASE_URL = baseUrl;
        const { controlApiRequest } = await import('@core/cli/control-api.js');

        await expect(
          controlApiRequest(makeTempDir(), {
            method: 'GET',
            path: '/v1/sessions',
          }),
        ).resolves.toEqual({ ok: true });
      },
    );
  });

  it('does not use legacy GANTRY_CONTROL_API_KEY as a bearer token source', async () => {
    process.env.GANTRY_CONTROL_API_KEY = 'legacy-token';

    const { controlApiRequest } = await import('@core/cli/control-api.js');

    await expect(
      controlApiRequest(makeTempDir(), {
        method: 'GET',
        path: '/v1/mcp-servers',
      }),
    ).rejects.toThrow(
      'GANTRY_CONTROL_API_KEYS_JSON with at least one complete key record is required',
    );
  });

  it('does not use incomplete JSON key records as bearer token sources', async () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      { token: 'token-without-scope-or-app' },
      {
        kid: 'missing-scope',
        token: 'token-without-scope',
        appId: 'app-one',
      },
      {
        kid: 'empty-scope',
        token: 'token-with-empty-scope',
        appId: 'app-one',
        scopes: [],
      },
    ]);

    const { controlApiRequest } = await import('@core/cli/control-api.js');

    await expect(
      controlApiRequest(makeTempDir(), {
        method: 'GET',
        path: '/v1/sessions',
      }),
    ).rejects.toThrow(
      'GANTRY_CONTROL_API_KEYS_JSON with at least one complete key record is required',
    );
  });

  it('selects the first JSON token with a valid app id and supported scopes', async () => {
    process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
      {
        kid: 'unsafe-app',
        token: 'bad-app-token',
        appId: 'app:one',
        scopes: ['sessions:read'],
      },
      {
        kid: 'unsupported-scope',
        token: 'bad-scope-token',
        appId: 'app-one',
        scopes: ['sessions:write', 'legacy:admin'],
      },
      {
        kid: 'valid',
        token: 'valid-token',
        appId: 'app-one',
        scopes: ['sessions:read'],
      },
    ]);

    await withControlServer(
      (req, res) => {
        expect(req.headers.authorization).toBe('Bearer valid-token');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      async (baseUrl) => {
        process.env.GANTRY_CONTROL_BASE_URL = baseUrl;
        const { controlApiRequest } = await import('@core/cli/control-api.js');

        await expect(
          controlApiRequest(makeTempDir(), {
            method: 'GET',
            path: '/v1/sessions',
          }),
        ).resolves.toEqual({ ok: true });
      },
    );
  });
});
