import http from 'http';
import https from 'https';
import net from 'net';
import { createHash } from 'crypto';
import type { Duplex } from 'stream';

import {
  evaluateEgressDenylist,
  normalizeEgressHost,
  type EgressSettings,
} from '../shared/egress-policy.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import { normalizeRuntimeEventConversationId } from '../domain/events/runtime-event-conversation.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { logger } from '../infrastructure/logging/logger.js';

export interface EgressGatewayPrincipal {
  appId: string;
  agentId?: string;
  conversationId?: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
}

export interface EgressGatewayUpstreamProxy {
  url: string;
  provider: string;
}

export interface EgressGatewayHandle {
  key: string;
  proxyUrl: string;
  port: number;
}

interface EgressGatewayState {
  key: string;
  port: number;
  server: http.Server;
  sockets: Set<Duplex>;
  settings: EgressSettings;
  principal: EgressGatewayPrincipal;
  upstreamProxy?: EgressGatewayUpstreamProxy;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}

const EGRESS_GATEWAY_BASE_PORT = 18_080;
const EGRESS_GATEWAY_PORT_SPAN = 2_000;
const EGRESS_GATEWAY_MAX_PORT_PROBES = 50;
const EGRESS_GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
const EGRESS_GATEWAY_CLOSE_TIMEOUT_MS = 1_000;
const gateways = new Map<string, EgressGatewayState>();

export async function closeEgressGatewaysForTest(): Promise<void> {
  const states = [...gateways.values()];
  gateways.clear();
  await Promise.all(states.map((state) => closeGatewayState(state)));
}

export async function closeEgressGateway(
  handleOrKey: EgressGatewayHandle | string | undefined,
): Promise<void> {
  if (!handleOrKey) return;
  const key = typeof handleOrKey === 'string' ? handleOrKey : handleOrKey.key;
  const state = gateways.get(key);
  if (!state) return;
  gateways.delete(key);
  await closeGatewayState(state);
}

export async function ensureEgressGateway(input: {
  key: string;
  settings: EgressSettings;
  principal: EgressGatewayPrincipal;
  upstreamProxy?: EgressGatewayUpstreamProxy;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}): Promise<EgressGatewayHandle> {
  const existing = gateways.get(input.key);
  if (existing) {
    existing.settings = input.settings;
    existing.principal = input.principal;
    if (input.upstreamProxy) {
      existing.upstreamProxy = input.upstreamProxy;
    } else {
      delete existing.upstreamProxy;
    }
    if (input.publishRuntimeEvent) {
      existing.publishRuntimeEvent = input.publishRuntimeEvent;
    } else {
      delete existing.publishRuntimeEvent;
    }
    return {
      key: input.key,
      proxyUrl: `http://127.0.0.1:${existing.port}/`,
      port: existing.port,
    };
  }
  const preferredPort = preferredEgressGatewayPort(input.key);
  for (let offset = 0; offset < EGRESS_GATEWAY_MAX_PORT_PROBES; offset += 1) {
    const port =
      EGRESS_GATEWAY_BASE_PORT +
      ((preferredPort - EGRESS_GATEWAY_BASE_PORT + offset) %
        EGRESS_GATEWAY_PORT_SPAN);
    try {
      const state: EgressGatewayState = {
        key: input.key,
        port,
        server: createEgressGatewayServer(input.key),
        sockets: new Set(),
        settings: input.settings,
        principal: input.principal,
        ...(input.upstreamProxy ? { upstreamProxy: input.upstreamProxy } : {}),
        ...(input.publishRuntimeEvent
          ? { publishRuntimeEvent: input.publishRuntimeEvent }
          : {}),
      };
      await listen(state.server, port);
      gateways.set(input.key, state);
      if (offset > 0) {
        logger.warn(
          { key: input.key, preferredPort, port },
          'Egress gateway preferred port was unavailable; using next stable candidate',
        );
      }
      return { key: input.key, proxyUrl: `http://127.0.0.1:${port}/`, port };
    } catch (err) {
      if (!isListenCollision(err)) throw err;
    }
  }
  throw new Error(`No available egress gateway port for ${input.key}.`);
}

function createEgressGatewayServer(key: string): http.Server {
  const server = http.createServer((req, res) => {
    void handleHttpProxyRequest(key, req, res).catch((err) => {
      logger.warn({ err, key }, 'Egress gateway HTTP request failed');
      if (!res.headersSent) res.writeHead(502);
      res.end('Bad Gateway');
    });
  });
  server.on('connect', (req, socket, head) => {
    void handleConnectRequest(key, req, socket, head).catch((err) => {
      logger.warn({ err, key }, 'Egress gateway CONNECT failed');
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });
  server.on('connection', (socket) => {
    const state = gateways.get(key);
    if (state) trackGatewaySocket(state, socket);
  });
  return server;
}

async function handleConnectRequest(
  key: string,
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): Promise<void> {
  const state = requireGatewayState(key);
  trackGatewaySocket(state, clientSocket);
  const target = parseConnectTarget(req.url || '');
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const deny = evaluateEgressDenylist({
    settings: state.settings,
    host: target.host,
  });
  if (deny) {
    await auditConnect(state, {
      host: deny.host,
      allowed: false,
      denied: true,
      reason: deny.reason,
      matchedPattern: deny.matchedPattern,
    });
    writeDeniedConnect(clientSocket, deny);
    return;
  }
  await auditConnect(state, {
    host: normalizeEgressHost(target.host),
    allowed: true,
    denied: false,
    reason: 'default_allow',
  });
  if (state.upstreamProxy) {
    await tunnelViaUpstreamProxy(
      state,
      state.upstreamProxy,
      target,
      clientSocket,
      head,
    );
    return;
  }
  await tunnelDirect(state, target, clientSocket, head);
}

async function handleHttpProxyRequest(
  key: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const state = requireGatewayState(key);
  const target = parseHttpProxyTarget(req.url || '');
  if (!target) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const deny = evaluateEgressDenylist({
    settings: state.settings,
    host: target.hostname,
  });
  if (deny) {
    await auditConnect(state, {
      host: deny.host,
      allowed: false,
      denied: true,
      reason: deny.reason,
      matchedPattern: deny.matchedPattern,
    });
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(deniedBody(deny)));
    return;
  }
  await auditConnect(state, {
    host: normalizeEgressHost(target.hostname),
    allowed: true,
    denied: false,
    reason: 'default_allow',
  });
  const upstream = state.upstreamProxy
    ? requestViaUpstreamProxy(state.upstreamProxy, req, target)
    : requestDirect(req, target);
  upstream.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad Gateway');
  });
  req.pipe(upstream);
}

function requestDirect(
  req: http.IncomingMessage,
  target: URL,
): http.ClientRequest {
  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: req.headers,
  });
  upstream.setTimeout(EGRESS_GATEWAY_CONNECT_TIMEOUT_MS, () => {
    upstream.destroy(new Error('Egress gateway HTTP upstream timed out.'));
  });
  return upstream;
}

function requestViaUpstreamProxy(
  upstream: EgressGatewayUpstreamProxy,
  req: http.IncomingMessage,
  target: URL,
): http.ClientRequest {
  const proxy = new URL(upstream.url);
  const headers = { ...req.headers };
  applyProxyAuthorization(headers, proxy);
  const upstreamRequest = http.request({
    hostname: proxy.hostname,
    port: proxy.port || 80,
    method: req.method,
    path: target.toString(),
    headers,
  });
  upstreamRequest.setTimeout(EGRESS_GATEWAY_CONNECT_TIMEOUT_MS, () => {
    upstreamRequest.destroy(
      new Error('Egress gateway upstream proxy request timed out.'),
    );
  });
  return upstreamRequest;
}

async function tunnelDirect(
  state: EgressGatewayState,
  target: { host: string; port: number; authority: string },
  clientSocket: Duplex,
  head: Buffer,
): Promise<void> {
  const upstreamSocket = net.connect(target.port, target.host, () => {
    upstreamSocket.setTimeout(0);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  trackGatewaySocket(state, upstreamSocket);
  upstreamSocket.on('error', () => {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  upstreamSocket.setTimeout(EGRESS_GATEWAY_CONNECT_TIMEOUT_MS, () => {
    upstreamSocket.destroy();
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
}

async function tunnelViaUpstreamProxy(
  state: EgressGatewayState,
  upstream: EgressGatewayUpstreamProxy,
  target: { host: string; port: number; authority: string },
  clientSocket: Duplex,
  head: Buffer,
): Promise<void> {
  const proxy = new URL(upstream.url);
  const proxySocket = net.connect(
    Number(proxy.port || 80),
    proxy.hostname,
    () => {
      const headers = [
        `CONNECT ${target.authority} HTTP/1.1`,
        `Host: ${target.authority}`,
      ];
      const authorization = proxyAuthorizationHeader(proxy);
      if (authorization) headers.push(`Proxy-Authorization: ${authorization}`);
      proxySocket.write(`${headers.join('\r\n')}\r\n\r\n`);
    },
  );
  trackGatewaySocket(state, proxySocket);
  let buffered = Buffer.alloc(0);
  let established = false;
  let failed = false;
  const failBeforeEstablished = () => {
    if (established || failed) return;
    failed = true;
    if (!clientSocket.destroyed && !clientSocket.writableEnded) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
    proxySocket.destroy();
  };
  proxySocket.on('data', function onProxyData(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    proxySocket.off('data', onProxyData);
    const header = buffered.slice(0, headerEnd).toString('utf-8');
    if (!/^HTTP\/1\.[01] 2\d\d\b/.test(header)) {
      clientSocket.end(`${header}\r\n\r\n`);
      proxySocket.destroy();
      return;
    }
    established = true;
    proxySocket.setTimeout(0);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const remainder = buffered.slice(headerEnd + 4);
    if (remainder.length > 0) clientSocket.write(remainder);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });
  proxySocket.on('error', () => {
    failBeforeEstablished();
  });
  proxySocket.on('end', failBeforeEstablished);
  proxySocket.on('close', failBeforeEstablished);
  proxySocket.setTimeout(
    EGRESS_GATEWAY_CONNECT_TIMEOUT_MS,
    failBeforeEstablished,
  );
}

function trackGatewaySocket(state: EgressGatewayState, socket: Duplex): void {
  state.sockets.add(socket);
  socket.once('close', () => {
    state.sockets.delete(socket);
  });
}

async function closeGatewayState(state: EgressGatewayState): Promise<void> {
  state.server.closeIdleConnections?.();
  state.server.closeAllConnections?.();
  for (const socket of state.sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      logger.warn(
        { key: state.key, port: state.port, sockets: state.sockets.size },
        'Timed out closing egress gateway; continuing run finalization',
      );
      finish();
    }, EGRESS_GATEWAY_CLOSE_TIMEOUT_MS);
    timeout.unref?.();
    state.server.close(() => finish());
  });
}

function writeDeniedConnect(
  socket: Duplex,
  deny: { host: string; matchedPattern: string; reason: string },
): void {
  const body = JSON.stringify(deniedBody(deny));
  socket.end(
    [
      'HTTP/1.1 403 Forbidden',
      'content-type: application/json',
      `content-length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'),
  );
}

function deniedBody(deny: {
  host: string;
  matchedPattern: string;
  reason: string;
}): Record<string, string> {
  return {
    deniedHost: deny.host,
    matchedPattern: deny.matchedPattern,
    reason: deny.reason,
  };
}

async function auditConnect(
  state: EgressGatewayState,
  decision: {
    host: string;
    allowed: boolean;
    denied: boolean;
    reason: string;
    matchedPattern?: string;
  },
): Promise<void> {
  const payload = {
    host: decision.host,
    principal: state.principal.agentId || state.principal.appId,
    allowed: decision.allowed,
    denied: decision.denied,
    reason: decision.reason,
    ...(decision.matchedPattern
      ? { matchedPattern: decision.matchedPattern }
      : {}),
    provider: state.upstreamProxy?.provider ?? 'direct',
    conversationId: state.principal.conversationId,
    runId: state.principal.runId,
  };
  logger.info(payload, 'Egress CONNECT decision');
  if (!state.publishRuntimeEvent) return;
  const eventConversationId = normalizeRuntimeEventConversationId(
    state.principal.conversationId as never,
  );
  try {
    await state.publishRuntimeEvent({
      appId: state.principal.appId as never,
      ...(state.principal.agentId
        ? { agentId: state.principal.agentId as never }
        : {}),
      ...(eventConversationId
        ? { conversationId: eventConversationId as never }
        : {}),
      eventType: RUNTIME_EVENT_TYPES.EGRESS_CONNECT as RuntimeEventType,
      actor: 'egress-gateway',
      responseMode: 'none',
      payload,
    });
  } catch (err) {
    logger.warn(
      { err, host: decision.host, principal: payload.principal },
      'Egress CONNECT audit persistence failed',
    );
  }
}

function requireGatewayState(key: string): EgressGatewayState {
  const state = gateways.get(key);
  if (!state) throw new Error(`Egress gateway state not found for ${key}.`);
  return state;
}

function parseConnectTarget(
  authority: string,
): { host: string; port: number; authority: string } | undefined {
  const parsed = parseAuthority(authority);
  if (!parsed) return undefined;
  return { ...parsed, authority };
}

function parseAuthority(
  authority: string,
): { host: string; port: number } | undefined {
  if (!authority.trim()) return undefined;
  const withScheme = `http://${authority}`;
  try {
    const parsed = new URL(withScheme);
    const host = normalizeEgressHost(parsed.hostname);
    const port = Number(parsed.port || 443);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      return undefined;
    }
    return { host, port };
  } catch {
    return undefined;
  }
}

function parseHttpProxyTarget(rawUrl: string): URL | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function applyProxyAuthorization(
  headers: http.OutgoingHttpHeaders,
  proxy: URL,
): void {
  const authorization = proxyAuthorizationHeader(proxy);
  if (authorization) headers['proxy-authorization'] = authorization;
}

function proxyAuthorizationHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function preferredEgressGatewayPort(key: string): number {
  const hash = createHash('sha256').update(key).digest();
  return (
    EGRESS_GATEWAY_BASE_PORT + (hash.readUInt32BE(0) % EGRESS_GATEWAY_PORT_SPAN)
  );
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function isListenCollision(err: unknown): boolean {
  return (
    Boolean(err) &&
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' ||
      (err as NodeJS.ErrnoException).code === 'EACCES')
  );
}
