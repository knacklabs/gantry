import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
const EGRESS_GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
export function requestDirect(req, target, connectHost) {
    const client = target.protocol === 'https:' ? https : http;
    const headers = connectHost
        ? { ...req.headers, host: target.host }
        : req.headers;
    const upstream = client.request({
        protocol: target.protocol,
        hostname: connectHost ?? target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        ...(connectHost && target.protocol === 'https:'
            ? { servername: target.hostname }
            : {}),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
    });
    upstream.setTimeout(EGRESS_GATEWAY_CONNECT_TIMEOUT_MS, () => {
        upstream.destroy(new Error('Egress gateway HTTP upstream timed out.'));
    });
    return upstream;
}
export function requestViaUpstreamProxy(upstream, req, target, connectHost) {
    const proxy = new URL(upstream.url);
    const headers = connectHost
        ? { ...req.headers, host: target.host }
        : { ...req.headers };
    applyProxyAuthorization(headers, proxy);
    const proxyTarget = connectHost
        ? pinnedProxyUrl(target, connectHost)
        : target;
    const upstreamRequest = http.request({
        hostname: proxy.hostname,
        port: proxy.port || 80,
        method: req.method,
        path: proxyTarget.toString(),
        headers,
    });
    upstreamRequest.setTimeout(EGRESS_GATEWAY_CONNECT_TIMEOUT_MS, () => {
        upstreamRequest.destroy(new Error('Egress gateway upstream proxy request timed out.'));
    });
    return upstreamRequest;
}
function pinnedProxyUrl(target, connectHost) {
    const pinned = new URL(target.toString());
    pinned.hostname =
        connectHost.includes(':') && !connectHost.startsWith('[')
            ? `[${connectHost}]`
            : connectHost;
    return pinned;
}
export async function tunnelDirect(input) {
    const { target, clientSocket, head } = input;
    const upstreamSocket = net.connect(target.port, target.connectHost ?? target.host, () => {
        upstreamSocket.setTimeout(0);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0)
            upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
    });
    input.trackSocket(upstreamSocket);
    upstreamSocket.on('error', () => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    upstreamSocket.setTimeout(EGRESS_GATEWAY_CONNECT_TIMEOUT_MS, () => {
        upstreamSocket.destroy();
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
}
export async function tunnelViaUpstreamProxy(input) {
    const { upstream, target, clientSocket, head } = input;
    const proxy = new URL(upstream.url);
    const proxyAuthority = target.connectHost
        ? connectAuthority(target.connectHost, target.port)
        : target.authority;
    const proxySocket = net.connect(Number(proxy.port || 80), proxy.hostname, () => {
        const headers = [
            `CONNECT ${proxyAuthority} HTTP/1.1`,
            `Host: ${target.authority}`,
        ];
        const authorization = proxyAuthorizationHeader(proxy);
        if (authorization)
            headers.push(`Proxy-Authorization: ${authorization}`);
        proxySocket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
    input.trackSocket(proxySocket);
    let buffered = Buffer.alloc(0);
    let established = false;
    let failed = false;
    const failBeforeEstablished = () => {
        if (established || failed)
            return;
        failed = true;
        if (!clientSocket.destroyed && !clientSocket.writableEnded) {
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
        proxySocket.destroy();
    };
    proxySocket.on('data', function onProxyData(chunk) {
        buffered = Buffer.concat([buffered, chunk]);
        const headerEnd = buffered.indexOf('\r\n\r\n');
        if (headerEnd === -1)
            return;
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
        if (remainder.length > 0)
            clientSocket.write(remainder);
        if (head.length > 0)
            proxySocket.write(head);
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);
    });
    proxySocket.on('error', () => {
        failBeforeEstablished();
    });
    proxySocket.on('end', failBeforeEstablished);
    proxySocket.on('close', failBeforeEstablished);
    proxySocket.setTimeout(EGRESS_GATEWAY_CONNECT_TIMEOUT_MS, failBeforeEstablished);
}
function connectAuthority(host, port) {
    return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
function applyProxyAuthorization(headers, proxy) {
    const authorization = proxyAuthorizationHeader(proxy);
    if (authorization)
        headers['proxy-authorization'] = authorization;
}
function proxyAuthorizationHeader(proxy) {
    if (!proxy.username && !proxy.password)
        return undefined;
    const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
}
