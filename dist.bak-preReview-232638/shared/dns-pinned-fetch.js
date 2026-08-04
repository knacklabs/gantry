import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { isIpAddress, isPrivateNetworkAddress, } from './network-host-declaration.js';
import { lookupHostnameWithDeadline } from './hostname-lookup-deadline.js';
const DNS_PINNED_MCP_FETCH_TIMEOUT_MS = 60_000;
/**
 * SSRF-safe DNS-pinned fetch for remote third-party MCP transports.
 *
 * The hostname is resolved once, validated to be public-routable, and the
 * resulting IP is pinned for the connection via a custom `lookup`, while TLS SNI
 * and certificate validation stay bound to the original hostname.
 */
export function createDnsPinnedMcpFetch(input) {
    const pinnedFetch = async (url, init) => {
        const target = toUrl(url);
        if (target.protocol !== 'https:' && target.protocol !== 'http:') {
            throw new Error('Remote MCP transport supports only http(s) URLs.');
        }
        const pinned = await resolvePinnedPublicMcpAddressWithDeadline(target.hostname, input.lookupHostname, init?.signal);
        return pinnedRequest(target, init, pinned);
    };
    return pinnedFetch;
}
export async function resolvePinnedPublicMcpAddress(hostname, lookupHostname) {
    if (isIpAddress(hostname)) {
        // URL.hostname keeps IPv6 literals bracketed (e.g. [2606:4700::1111]); the
        // node lookup/connect callback needs the bare address.
        const address = hostname.replace(/^\[/, '').replace(/\]$/, '');
        if (isPrivateNetworkAddress(address)) {
            throw new Error('MCP server address must be public and routable.');
        }
        return { address, family: address.includes(':') ? 6 : 4 };
    }
    if (!lookupHostname) {
        throw new Error('MCP server hostname did not resolve to a public address.');
    }
    const records = await lookupHostname(hostname);
    const firstPublic = records.find((record) => !isPrivateNetworkAddress(record.address));
    if (records.length === 0 ||
        !firstPublic ||
        records.some((record) => isPrivateNetworkAddress(record.address))) {
        throw new Error('MCP server hostname must resolve only to public routable addresses.');
    }
    return firstPublic;
}
function pinnedRequest(target, init, pinned) {
    const client = target.protocol === 'https:' ? https : http;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = normalizeHeaders(init?.headers);
    const lookup = ((_hostname, options, callback) => {
        if (options &&
            typeof options === 'object' &&
            options.all) {
            callback(null, [{ address: pinned.address, family: pinned.family }]);
            return;
        }
        callback(null, pinned.address, pinned.family);
    });
    return new Promise((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        let responseStream;
        let resolved = false;
        const timeout = setTimeout(() => {
            fail(new Error('Remote MCP transport request timed out.'));
        }, DNS_PINNED_MCP_FETCH_TIMEOUT_MS);
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error) => {
            cleanup();
            request.destroy(error);
            responseStream?.destroy(error);
            if (!resolved)
                reject(error);
        };
        const onAbort = () => fail(abortError());
        const request = client.request(target, {
            method,
            headers,
            lookup,
            ...(target.protocol === 'https:'
                ? { servername: target.hostname }
                : {}),
        }, (response) => {
            clearTimeout(timeout);
            responseStream = response;
            const status = response.statusCode ?? 502;
            if (init?.redirect === 'error' && status >= 300 && status < 400) {
                response.destroy();
                fail(new Error('Remote MCP transport returned a redirect, which is not allowed.'));
                return;
            }
            response.on('end', cleanup);
            response.on('close', cleanup);
            resolved = true;
            resolve(new Response(Readable.toWeb(response), {
                status,
                headers: responseHeaders(response.headers),
            }));
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        request.on('error', (error) => {
            cleanup();
            if (!resolved)
                reject(error);
        });
        const body = init?.body;
        if (body !== undefined && body !== null) {
            request.write(typeof body === 'string' ? body : Buffer.from(body));
        }
        request.end();
    });
}
function abortError() {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Remote MCP transport request aborted.', 'AbortError');
    }
    const error = new Error('Remote MCP transport request aborted.');
    error.name = 'AbortError';
    return error;
}
async function resolvePinnedPublicMcpAddressWithDeadline(hostname, lookupHostname, signal) {
    if (isIpAddress(hostname)) {
        return resolvePinnedPublicMcpAddress(hostname, lookupHostname);
    }
    if (!lookupHostname) {
        return resolvePinnedPublicMcpAddress(hostname, lookupHostname);
    }
    const records = await lookupHostnameWithDeadline({
        hostname,
        lookupHostname,
        timeoutMs: DNS_PINNED_MCP_FETCH_TIMEOUT_MS,
        timeoutMessage: 'Remote MCP transport request timed out.',
        signal,
    });
    const firstPublic = records.find((record) => !isPrivateNetworkAddress(record.address));
    if (records.length === 0 ||
        !firstPublic ||
        records.some((record) => isPrivateNetworkAddress(record.address))) {
        throw new Error('MCP server hostname must resolve only to public routable addresses.');
    }
    return firstPublic;
}
function normalizeHeaders(headers) {
    const out = {};
    if (!headers)
        return out;
    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            out[key] = value;
        });
        return out;
    }
    if (Array.isArray(headers)) {
        for (const entry of headers) {
            if (Array.isArray(entry) && entry.length === 2) {
                out[String(entry[0])] = String(entry[1]);
            }
        }
        return out;
    }
    for (const [key, value] of Object.entries(headers)) {
        out[key] = value;
    }
    return out;
}
function responseHeaders(headers) {
    const out = new Headers();
    for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
            for (const entry of value)
                out.append(key, entry);
        }
        else if (value !== undefined) {
            out.set(key, value);
        }
    }
    return out;
}
function toUrl(url) {
    if (typeof url === 'string')
        return new URL(url);
    if (url instanceof URL)
        return new URL(url.toString());
    return new URL(url.url);
}
