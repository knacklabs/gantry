import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { createClient } from '@gantry/sdk';

const DEFAULT_PORT = 4173;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DIST = fileURLToPath(new URL('../dist', import.meta.url));
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendFailure(response, code, retryable) {
  sendJson(response, 503, {
    error: { code, requestId: randomUUID(), retryable },
  });
}

function createSdkClient(env) {
  const apiKey = env.GANTRY_CONTROL_API_KEY?.trim();
  const baseUrl = env.GANTRY_CONTROL_BASE_URL?.trim();
  const socketPath = env.GANTRY_CONTROL_SOCKET_PATH?.trim();
  if (!apiKey || (!baseUrl && !socketPath)) return null;

  return createClient({
    apiKey,
    baseUrl: baseUrl || undefined,
    socketPath: socketPath || undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

async function handleApi(method, pathname, response, env) {
  if (method !== 'GET') {
    response.writeHead(405, { allow: 'GET' });
    response.end();
    return;
  }

  if (pathname !== '/ui/api/connection' && pathname !== '/ui/api/agents') {
    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', requestId: randomUUID(), retryable: false },
    });
    return;
  }

  let client;
  try {
    client = createSdkClient(env);
  } catch {
    sendFailure(response, 'UI_CONFIGURATION_ERROR', false);
    return;
  }
  if (!client) {
    sendFailure(response, 'UI_NOT_CONFIGURED', false);
    return;
  }

  try {
    if (pathname === '/ui/api/connection') {
      const health = await client.health();
      sendJson(response, 200, {
        status: health.status,
        processRole: health.processRole,
        features: {
          sessions: health.features.sessions,
          jobs: health.features.jobs,
          events: health.features.events,
          webhooks: health.features.webhooks,
        },
      });
      return;
    }

    if (pathname === '/ui/api/agents') {
      const result = await client.agents.list();
      sendJson(response, 200, {
        agents: result.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        })),
      });
      return;
    }
  } catch {
    sendFailure(response, 'CONTROL_API_UNAVAILABLE', true);
    return;
  }
}

async function readStatic(pathname, distRoot) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice('/ui/'.length));
  } catch {
    return null;
  }

  const root = resolve(distRoot);
  const requested = resolve(root, relativePath);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) return null;

  try {
    return { path: requested, body: await readFile(requested) };
  } catch {
    if (extname(relativePath)) return null;
    try {
      const path = resolve(root, 'index.html');
      return { path, body: await readFile(path) };
    } catch {
      return null;
    }
  }
}

export function createUiHandler(options = {}) {
  const env = options.env ?? process.env;
  const distRoot = options.distRoot ?? DEFAULT_DIST;

  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://ui.local');
    if (url.pathname === '/ui/api' || url.pathname.startsWith('/ui/api/')) {
      await handleApi(request.method, url.pathname, response, env);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (url.pathname !== '/ui' && !url.pathname.startsWith('/ui/')) {
      response.writeHead(404);
      response.end();
      return;
    }

    const file = await readStatic(
      url.pathname === '/ui' || url.pathname === '/ui/'
        ? '/ui/index.html'
        : url.pathname,
      distRoot,
    );
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, {
      'content-type':
        CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream',
    });
    response.end(request.method === 'HEAD' ? undefined : file.body);
  };
}

export function createUiServer(options = {}) {
  return createServer(createUiHandler(options));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port =
    Number.parseInt(process.env.GANTRY_UI_PORT ?? '', 10) || DEFAULT_PORT;
  createUiServer().listen(port, '127.0.0.1');
}
