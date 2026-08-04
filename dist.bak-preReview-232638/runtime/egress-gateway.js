import http from 'http';
import { createHash } from 'crypto';
import { evaluateEgressDenylist, evaluateNonPublicEgressAddress, normalizeEgressHost, } from '../shared/egress-policy.js';
import { logger } from '../infrastructure/logging/logger.js';
import { requestDirect, requestViaUpstreamProxy, tunnelDirect, tunnelViaUpstreamProxy, } from './egress-gateway-proxying.js';
import { declaredNetworkAuthority } from '../shared/network-host-declaration.js';
import { resolvePublicEgressAddress } from '../shared/egress-target-resolution.js';
import { mappedEgressTarget, networkAttributionMap, } from './egress-gateway-access-policy.js';
import { auditConnect } from './egress-gateway-audit.js';
const EGRESS_GATEWAY_BASE_PORT = 18_080;
const EGRESS_GATEWAY_PORT_SPAN = 2_000;
const EGRESS_GATEWAY_MAX_PORT_PROBES = 50;
const EGRESS_GATEWAY_CLOSE_TIMEOUT_MS = 1_000;
const gateways = new Map();
export async function closeEgressGatewaysForTest() {
    const states = [...gateways.values()];
    gateways.clear();
    await Promise.all(states.map((state) => closeGatewayState(state)));
}
export async function closeEgressGateway(handleOrKey) {
    if (!handleOrKey)
        return;
    const key = typeof handleOrKey === 'string' ? handleOrKey : handleOrKey.key;
    const state = gateways.get(key);
    if (!state)
        return;
    gateways.delete(key);
    await closeGatewayState(state);
}
export async function ensureEgressGateway(input) {
    const existing = gateways.get(input.key);
    if (existing) {
        existing.settings = input.settings;
        existing.principal = input.principal;
        existing.networkAttribution = networkAttributionMap(input.networkAttribution);
        existing.connectHostMappings = connectHostMappings(input.privateNetworkHostMappings);
        if (input.upstreamProxy) {
            existing.upstreamProxy = input.upstreamProxy;
        }
        else {
            delete existing.upstreamProxy;
        }
        if (input.publishRuntimeEvent) {
            existing.publishRuntimeEvent = input.publishRuntimeEvent;
        }
        else {
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
        const port = EGRESS_GATEWAY_BASE_PORT +
            ((preferredPort - EGRESS_GATEWAY_BASE_PORT + offset) %
                EGRESS_GATEWAY_PORT_SPAN);
        try {
            const networkAttribution = networkAttributionMap(input.networkAttribution);
            const state = {
                key: input.key,
                port,
                server: createEgressGatewayServer(input.key),
                sockets: new Set(),
                settings: input.settings,
                principal: input.principal,
                networkAttribution,
                logger,
                connectHostMappings: connectHostMappings(input.privateNetworkHostMappings),
                ...(input.upstreamProxy ? { upstreamProxy: input.upstreamProxy } : {}),
                ...(input.publishRuntimeEvent
                    ? { publishRuntimeEvent: input.publishRuntimeEvent }
                    : {}),
            };
            await listen(state.server, port);
            gateways.set(input.key, state);
            if (offset > 0) {
                logger.warn({ key: input.key, preferredPort, port }, 'Egress gateway preferred port was unavailable; using next stable candidate');
            }
            return { key: input.key, proxyUrl: `http://127.0.0.1:${port}/`, port };
        }
        catch (err) {
            if (!isListenCollision(err))
                throw err;
        }
    }
    throw new Error(`No available egress gateway port for ${input.key}.`);
}
function connectHostMappings(mappings) {
    const map = new Map();
    for (const mapping of mappings ?? []) {
        const authority = declaredNetworkAuthority(mapping.authority);
        const connectHost = mapping.connectHost.trim();
        if (authority && connectHost)
            map.set(authority, connectHost);
    }
    return map.size > 0 ? map : undefined;
}
function createEgressGatewayServer(key) {
    const server = http.createServer((req, res) => {
        void handleHttpProxyRequest(key, req, res).catch((err) => {
            logger.warn({ err, key }, 'Egress gateway HTTP request failed');
            if (!res.headersSent)
                res.writeHead(502);
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
        if (state)
            trackGatewaySocket(state, socket);
    });
    server.on('clientError', (err, socket) => {
        logger.debug({ err, key }, 'Egress gateway client socket error');
        socket.destroy();
    });
    server.on('error', (err) => {
        logger.warn({ err, key }, 'Egress gateway server error');
    });
    return server;
}
async function handleConnectRequest(key, req, clientSocket, head) {
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
        await denyConnectRequest(state, clientSocket, deny, target.port);
        return;
    }
    const literalAddressDeny = evaluateNonPublicEgressAddress({
        host: target.host,
        address: target.host,
    });
    if (literalAddressDeny) {
        await denyConnectRequest(state, clientSocket, literalAddressDeny, target.port);
        return;
    }
    const mappedTarget = mappedEgressTarget(state, target);
    if (mappedTarget) {
        await auditConnect(state, {
            host: mappedTarget.host,
            port: target.port,
            allowed: true,
            denied: false,
            reason: 'mapped_connect_host',
        });
        await tunnelDirect({
            target: mappedTarget,
            clientSocket,
            head,
            trackSocket: (socket) => trackGatewaySocket(state, socket),
        });
        return;
    }
    const resolution = await resolveEgressTarget(target);
    if ('deny' in resolution) {
        await denyConnectRequest(state, clientSocket, resolution.deny, target.port);
        return;
    }
    const resolvedTarget = resolution.target;
    await auditConnect(state, {
        host: normalizeEgressHost(target.host),
        port: target.port,
        allowed: true,
        denied: false,
        reason: 'default_allow',
    });
    if (state.upstreamProxy) {
        await tunnelViaUpstreamProxy({
            upstream: state.upstreamProxy,
            target: resolvedTarget,
            clientSocket,
            head,
            trackSocket: (socket) => trackGatewaySocket(state, socket),
        });
        return;
    }
    await tunnelDirect({
        target: resolvedTarget,
        clientSocket,
        head,
        trackSocket: (socket) => trackGatewaySocket(state, socket),
    });
}
async function handleHttpProxyRequest(key, req, res) {
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
        await denyHttpRequest(state, res, deny, urlPort(target));
        return;
    }
    const literalAddressDeny = evaluateNonPublicEgressAddress({
        host: target.hostname,
        address: target.hostname,
    });
    if (literalAddressDeny) {
        await denyHttpRequest(state, res, literalAddressDeny, urlPort(target));
        return;
    }
    const mappedTarget = mappedEgressTarget(state, {
        host: normalizeEgressHost(target.hostname),
        port: urlPort(target),
        authority: target.host,
    });
    if (mappedTarget) {
        await auditConnect(state, {
            host: mappedTarget.host,
            port: urlPort(target),
            allowed: true,
            denied: false,
            reason: 'mapped_connect_host',
        });
        const upstream = requestDirect(req, target, mappedTarget.connectHost);
        upstream.on('response', (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstream.on('error', () => {
            if (!res.headersSent)
                res.writeHead(502);
            res.end('Bad Gateway');
        });
        req.pipe(upstream);
        return;
    }
    const resolution = await resolveEgressTarget({
        host: normalizeEgressHost(target.hostname),
        port: urlPort(target),
        authority: target.host,
    });
    if ('deny' in resolution) {
        await denyHttpRequest(state, res, resolution.deny, urlPort(target));
        return;
    }
    const resolvedTarget = resolution.target;
    await auditConnect(state, {
        host: normalizeEgressHost(target.hostname),
        port: urlPort(target),
        allowed: true,
        denied: false,
        reason: 'default_allow',
    });
    const upstream = state.upstreamProxy
        ? requestViaUpstreamProxy(state.upstreamProxy, req, target, resolvedTarget.connectHost)
        : requestDirect(req, target, resolvedTarget.connectHost);
    upstream.on('response', (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
        if (!res.headersSent)
            res.writeHead(502);
        res.end('Bad Gateway');
    });
    req.pipe(upstream);
}
function trackGatewaySocket(state, socket) {
    if (state.sockets.has(socket))
        return;
    state.sockets.add(socket);
    const onError = (err) => {
        logger.debug({ err, key: state.key, port: state.port }, 'Egress gateway socket error');
    };
    socket.on('error', onError);
    socket.once('close', () => {
        state.sockets.delete(socket);
        socket.off('error', onError);
    });
}
async function closeGatewayState(state) {
    state.server.closeIdleConnections?.();
    state.server.closeAllConnections?.();
    for (const socket of state.sockets) {
        socket.destroy();
    }
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            resolve();
        };
        const timeout = setTimeout(() => {
            logger.warn({ key: state.key, port: state.port, sockets: state.sockets.size }, 'Timed out closing egress gateway; continuing run finalization');
            finish();
        }, EGRESS_GATEWAY_CLOSE_TIMEOUT_MS);
        timeout.unref?.();
        state.server.close(() => finish());
    });
}
function writeDeniedConnect(socket, deny) {
    const body = JSON.stringify(deniedBody(deny));
    socket.end([
        `HTTP/1.1 403 ${deniedConnectReasonPhrase(deny)}`,
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        '',
        body,
    ].join('\r\n'));
}
async function denyConnectRequest(state, socket, deny, port) {
    await auditConnect(state, {
        host: deny.host,
        port,
        allowed: false,
        denied: true,
        reason: deny.reason,
        matchedPattern: deny.matchedPattern,
    });
    writeDeniedConnect(socket, deny);
}
async function denyHttpRequest(state, res, deny, port) {
    await auditConnect(state, {
        host: deny.host,
        port,
        allowed: false,
        denied: true,
        reason: deny.reason,
        matchedPattern: deny.matchedPattern,
    });
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(deniedBody(deny)));
}
function deniedConnectReasonPhrase(deny) {
    const message = `Gantry blocked egress to ${deny.host}`;
    return sanitizeHttpReasonPhrase(message);
}
function sanitizeHttpReasonPhrase(value) {
    const sanitized = value
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[^\x20-\x7E]+/g, '')
        .slice(0, 180)
        .trim();
    return sanitized || 'Forbidden';
}
function deniedBody(deny) {
    return {
        deniedHost: deny.host,
        matchedPattern: deny.matchedPattern,
        reason: deny.reason,
    };
}
async function resolveEgressTarget(target) {
    const host = normalizeEgressHost(target.host);
    const resolution = await resolvePublicEgressAddress(host);
    if (!resolution.ok) {
        return { deny: resolution.deny ?? dnsResolutionDeny(host) };
    }
    return {
        target: { ...target, host, connectHost: resolution.address },
    };
}
function dnsResolutionDeny(host) {
    return {
        host,
        matchedPattern: 'dns-resolution-failed',
        reason: `Egress gateway could not safely resolve ${host}.`,
    };
}
function requireGatewayState(key) {
    const state = gateways.get(key);
    if (!state)
        throw new Error(`Egress gateway state not found for ${key}.`);
    return state;
}
function parseConnectTarget(authority) {
    const parsed = parseAuthority(authority);
    if (!parsed)
        return undefined;
    return { ...parsed, authority };
}
function parseAuthority(authority) {
    if (!authority.trim())
        return undefined;
    const withScheme = `http://${authority}`;
    try {
        const parsed = new URL(withScheme);
        const host = normalizeEgressHost(parsed.hostname);
        const port = Number(parsed.port || 443);
        if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
            return undefined;
        }
        return { host, port };
    }
    catch {
        return undefined;
    }
}
function parseHttpProxyTarget(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
function urlPort(target) {
    return Number(target.port || (target.protocol === 'https:' ? 443 : 80));
}
function preferredEgressGatewayPort(key) {
    const hash = createHash('sha256').update(key).digest();
    return (EGRESS_GATEWAY_BASE_PORT + (hash.readUInt32BE(0) % EGRESS_GATEWAY_PORT_SPAN));
}
function listen(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
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
function isListenCollision(err) {
    return (Boolean(err) &&
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err.code === 'EADDRINUSE' ||
            err.code === 'EACCES'));
}
