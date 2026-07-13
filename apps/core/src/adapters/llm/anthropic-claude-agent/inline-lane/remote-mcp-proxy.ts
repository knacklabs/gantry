import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
} from '../../../../application/mcp/mcp-tool-proxy-network.js';
import type { MaterializedMcpCapability } from '../../../../application/mcp/mcp-server-service.js';
import type { HostnameLookup } from '../../../../domain/network/public-address-policy.js';

const MAX_MCP_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_SSE_HANDSHAKE_BYTES = 64 * 1024;
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

export interface SseProxyEndpointState {
  advertisedTarget?: URL;
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
  const sseEndpointState: SseProxyEndpointState = {};
  return http.createServer((request, response) => {
    void forwardRequest(request, response, input, sseEndpointState).catch(
      (error) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        response.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end('Remote MCP request failed.');
      },
    );
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
  sseEndpointState: SseProxyEndpointState,
): Promise<void> {
  if (request.headers[PROXY_AUTH_HEADER] !== input.proxyToken) {
    throw new Error('Inline MCP proxy authentication failed.');
  }
  const target = proxyTarget(
    request.url,
    input.target,
    input.targetType,
    sseEndpointState,
  );
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
  const bodyStream = Readable.fromWeb(upstream.body as never);
  const isSseHandshake =
    input.targetType === 'sse' &&
    request.method === 'GET' &&
    sameMcpEndpoint(target, input.target) &&
    upstream.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('text/event-stream');
  await pipeline(
    isSseHandshake
      ? bodyStream.pipe(
          createSseEndpointCapture(
            input.target,
            sseEndpointState,
            new URL(
              request.url ?? '/',
              `http://127.0.0.1:${request.socket.localPort}`,
            ),
          ),
        )
      : bodyStream,
    response,
  );
}

export function proxyTarget(
  requestUrl: string | undefined,
  configuredTarget: URL,
  targetType: 'http' | 'sse',
  sseEndpointState: SseProxyEndpointState = {},
): URL {
  const value = requestUrl ?? '/';
  if (!value.startsWith('/')) {
    throw new Error('Inline MCP proxy requires an origin-form request target.');
  }
  const target = new URL(value, configuredTarget.origin);
  if (
    target.origin !== configuredTarget.origin ||
    !pathWithinMcpEndpoint(
      target,
      configuredTarget,
      targetType,
      sseEndpointState,
    )
  ) {
    throw new Error(
      'Inline MCP proxy request escaped its configured endpoint.',
    );
  }
  return target;
}

function pathWithinMcpEndpoint(
  candidate: URL,
  configured: URL,
  targetType: 'http' | 'sse',
  sseEndpointState: SseProxyEndpointState,
): boolean {
  if (targetType === 'http') {
    const prefix = configured.pathname.endsWith('/')
      ? configured.pathname
      : `${configured.pathname}/`;
    return (
      candidate.pathname === configured.pathname ||
      candidate.pathname.startsWith(prefix)
    );
  }
  return (
    sameMcpEndpoint(candidate, configured) ||
    (sseEndpointState.advertisedTarget !== undefined &&
      sameMcpEndpoint(candidate, sseEndpointState.advertisedTarget))
  );
}

function sameMcpEndpoint(left: URL, right: URL): boolean {
  return (
    left.origin === right.origin &&
    left.pathname === right.pathname &&
    left.search === right.search
  );
}

export function createSseEndpointCapture(
  configuredTarget: URL,
  state: SseProxyEndpointState,
  proxyTarget: URL,
): Transform {
  let pending = Buffer.alloc(0);
  let handshakeBytes = 0;
  let captured = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (captured) {
        callback(null, chunk);
        return;
      }
      try {
        handshakeBytes += chunk.byteLength;
        pending = Buffer.concat([pending, chunk]);
        const output: Buffer[] = [];
        let boundary = findSseEventBoundary(pending);
        while (boundary) {
          const eventBlock = pending.subarray(0, boundary.index);
          const separator = pending.subarray(
            boundary.index,
            boundary.index + boundary.length,
          );
          pending = pending.subarray(boundary.index + boundary.length);
          const rewritten = rewriteSseEndpointEvent(
            eventBlock,
            configuredTarget,
            proxyTarget,
          );
          output.push(rewritten?.block ?? eventBlock, separator);
          if (rewritten) {
            state.advertisedTarget = rewritten.advertisedTarget;
            captured = true;
            output.push(pending);
            pending = Buffer.alloc(0);
            break;
          }
          boundary = findSseEventBoundary(pending);
        }
        if (!captured && handshakeBytes > MAX_SSE_HANDSHAKE_BYTES) {
          throw new Error('Inline MCP SSE handshake is too large.');
        }
        callback(null, Buffer.concat(output));
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      callback(null, pending);
    },
  });
}

function findSseEventBoundary(
  buffer: Buffer,
): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function rewriteSseEndpointEvent(
  eventBlock: Buffer,
  configuredTarget: URL,
  proxyTarget: URL,
): { advertisedTarget: URL; block: Buffer } | undefined {
  const text = eventBlock.toString('utf8');
  let eventType = 'message';
  const data: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') eventType = value;
    if (field === 'data') data.push(value);
  }
  if (eventType !== 'endpoint' || data.length === 0) return undefined;
  try {
    const advertised = new URL(data.join('\n'), configuredTarget);
    if (advertised.origin !== configuredTarget.origin) {
      throw new Error('Inline MCP SSE endpoint escaped its configured origin.');
    }
    const rewritten = new URL(
      `${advertised.pathname}${advertised.search}${advertised.hash}`,
      proxyTarget.origin,
    );
    let replaced = false;
    const rewrittenLines: string[] = [];
    for (const line of lines) {
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      if (field !== 'data') {
        rewrittenLines.push(line);
      } else if (!replaced) {
        const hasSpace = line.slice(separator + 1).startsWith(' ');
        rewrittenLines.push(`data:${hasSpace ? ' ' : ''}${rewritten.href}`);
        replaced = true;
      }
    }
    return {
      advertisedTarget: advertised,
      block: Buffer.from(
        rewrittenLines.join(text.includes('\r\n') ? '\r\n' : '\n'),
      ),
    };
  } catch (error) {
    throw new Error('Inline MCP SSE endpoint is invalid or not allowed.', {
      cause: error,
    });
  }
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
