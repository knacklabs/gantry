import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
} from '../../../../application/mcp/mcp-tool-proxy-network.js';
import type { MaterializedMcpCapability } from '../../../../application/mcp/mcp-server-service.js';
import type { HostnameLookup } from '../../../../domain/network/public-address-policy.js';

const MAX_MCP_REQUEST_BYTES = 4 * 1024 * 1024;
const PROXY_AUTH_HEADER = 'x-gantry-inline-mcp-token';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  PROXY_AUTH_HEADER,
]);

export interface ProxiedClaudeMcpServer {
  name: string;
  type: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
  allowedToolPatterns: readonly string[];
}

export async function createPinnedClaudeMcpProxies(input: {
  servers: readonly MaterializedMcpCapability[];
  egressDenylist: readonly string[];
  lookupHostname?: HostnameLookup;
}): Promise<{
  servers: ProxiedClaudeMcpServer[];
  close(): Promise<void>;
}> {
  const guardedFetch = createGuardedMcpFetch({
    lookupHostname: input.lookupHostname,
  });
  const proxies: Array<{
    server: http.Server;
    projection: ProxiedClaudeMcpServer;
  }> = [];
  try {
    for (const capability of input.servers) {
      if (
        capability.config.type !== 'http' &&
        capability.config.type !== 'sse'
      ) {
        continue;
      }
      assertMcpNetworkHostAllowed({
        serverName: capability.name,
        url: capability.config.url,
        denylist: input.egressDenylist,
      });
      const proxyToken = randomBytes(32).toString('base64url');
      const server = createProxyServer({
        target: new URL(capability.config.url),
        targetType: capability.config.type,
        configuredHeaders: capability.config.headers,
        guardedFetch,
        proxyToken,
      });
      const address = await listenLoopback(server);
      const target = new URL(capability.config.url);
      proxies.push({
        server,
        projection: {
          name: capability.name,
          type: capability.config.type,
          url: `http://127.0.0.1:${address.port}${target.pathname}${target.search}`,
          headers: { [PROXY_AUTH_HEADER]: proxyToken },
          allowedToolPatterns: capability.allowedToolPatterns,
        },
      });
    }
  } catch (error) {
    await Promise.all(proxies.map(({ server }) => closeServer(server)));
    throw error;
  }
  return {
    servers: proxies.map(({ projection }) => projection),
    close: () =>
      Promise.all(proxies.map(({ server }) => closeServer(server))).then(
        () => undefined,
      ),
  };
}

function createProxyServer(input: {
  target: URL;
  targetType: 'http' | 'sse';
  configuredHeaders?: Record<string, string>;
  guardedFetch: typeof fetch;
  proxyToken: string;
}): http.Server {
  return http.createServer((request, response) => {
    void forwardRequest(request, response, input).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Remote MCP request failed.');
    });
  });
}

async function forwardRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  input: {
    target: URL;
    targetType: 'http' | 'sse';
    configuredHeaders?: Record<string, string>;
    guardedFetch: typeof fetch;
    proxyToken: string;
  },
): Promise<void> {
  if (request.headers[PROXY_AUTH_HEADER] !== input.proxyToken) {
    throw new Error('Inline MCP proxy authentication failed.');
  }
  const target = proxyTarget(request.url, input.target, input.targetType);
  const abort = new AbortController();
  request.once('aborted', () => abort.abort());
  const body = await readRequestBody(request);
  const upstream = await input.guardedFetch(target, {
    method: request.method,
    headers: forwardedRequestHeaders(request.headers, input.configuredHeaders),
    ...(body.length > 0 ? { body } : {}),
    redirect: 'error',
    signal: abort.signal,
  });
  response.writeHead(
    upstream.status,
    forwardedResponseHeaders(upstream.headers),
  );
  if (!upstream.body) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as never), response);
}

function proxyTarget(
  requestUrl: string | undefined,
  configuredTarget: URL,
  targetType: 'http' | 'sse',
): URL {
  const value = requestUrl ?? '/';
  if (!value.startsWith('/')) {
    throw new Error('Inline MCP proxy requires an origin-form request target.');
  }
  const target = new URL(value, configuredTarget.origin);
  if (
    target.origin !== configuredTarget.origin ||
    !pathWithinMcpEndpoint(
      target.pathname,
      configuredTarget.pathname,
      targetType,
    )
  ) {
    throw new Error(
      'Inline MCP proxy request escaped its configured endpoint.',
    );
  }
  return target;
}

function pathWithinMcpEndpoint(
  candidate: string,
  configured: string,
  targetType: 'http' | 'sse',
): boolean {
  if (targetType === 'http') {
    const prefix = configured.endsWith('/') ? configured : `${configured}/`;
    return candidate === configured || candidate.startsWith(prefix);
  }
  const directory = configured.slice(0, configured.lastIndexOf('/') + 1);
  return candidate.startsWith(directory);
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_MCP_REQUEST_BYTES) {
      throw new Error('Remote MCP request body is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function forwardedRequestHeaders(
  incoming: http.IncomingHttpHeaders,
  configured?: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined)
      continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

function forwardedResponseHeaders(incoming: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  incoming.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}

function listenLoopback(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Inline MCP proxy did not bind a TCP address.'));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
