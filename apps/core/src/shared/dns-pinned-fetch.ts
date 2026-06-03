import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

import {
  isIpAddress,
  isPrivateNetworkAddress,
} from './network-host-declaration.js';
import { lookupHostnameWithDeadline } from './hostname-lookup-deadline.js';

const DNS_PINNED_MCP_FETCH_TIMEOUT_MS = 60_000;

export type DnsPinnedHostnameLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

/**
 * SSRF-safe DNS-pinned fetch for remote third-party MCP transports.
 *
 * The hostname is resolved once, validated to be public-routable, and the
 * resulting IP is pinned for the connection via a custom `lookup`, while TLS SNI
 * and certificate validation stay bound to the original hostname.
 */
export function createDnsPinnedMcpFetch(input: {
  lookupHostname?: DnsPinnedHostnameLookup;
}): typeof fetch {
  const pinnedFetch = async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const target = toUrl(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error('Remote MCP transport supports only http(s) URLs.');
    }
    const pinned = await resolvePinnedPublicMcpAddressWithDeadline(
      target.hostname,
      input.lookupHostname,
      init?.signal,
    );
    return pinnedRequest(target, init, pinned);
  };
  return pinnedFetch as typeof fetch;
}

export async function resolvePinnedPublicMcpAddress(
  hostname: string,
  lookupHostname?: DnsPinnedHostnameLookup,
): Promise<{ address: string; family: 4 | 6 }> {
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
  const firstPublic = records.find(
    (record) => !isPrivateNetworkAddress(record.address),
  );
  if (
    records.length === 0 ||
    !firstPublic ||
    records.some((record) => isPrivateNetworkAddress(record.address))
  ) {
    throw new Error(
      'MCP server hostname must resolve only to public routable addresses.',
    );
  }
  return firstPublic;
}

function pinnedRequest(
  target: URL,
  init: Parameters<typeof fetch>[1] | undefined,
  pinned: { address: string; family: 4 | 6 },
): Promise<Response> {
  const client = target.protocol === 'https:' ? https : http;
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init?.headers);
  const lookup = ((
    _hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    if (
      options &&
      typeof options === 'object' &&
      (options as { all?: boolean }).all
    ) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  }) as unknown as undefined;

  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let responseStream: http.IncomingMessage | undefined;
    let resolved = false;
    const timeout = setTimeout(() => {
      fail(new Error('Remote MCP transport request timed out.'));
    }, DNS_PINNED_MCP_FETCH_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      request.destroy(error);
      responseStream?.destroy(error);
      if (!resolved) reject(error);
    };
    const onAbort = () => fail(abortError());
    const request = client.request(
      target,
      {
        method,
        headers,
        lookup,
        ...(target.protocol === 'https:'
          ? { servername: target.hostname }
          : {}),
      },
      (response) => {
        clearTimeout(timeout);
        responseStream = response;
        const status = response.statusCode ?? 502;
        if (init?.redirect === 'error' && status >= 300 && status < 400) {
          response.destroy();
          fail(
            new Error(
              'Remote MCP transport returned a redirect, which is not allowed.',
            ),
          );
          return;
        }
        response.on('end', cleanup);
        response.on('close', cleanup);
        resolved = true;
        resolve(
          new Response(
            Readable.toWeb(response) as unknown as ConstructorParameters<
              typeof Response
            >[0],
            {
              status,
              headers: responseHeaders(response.headers),
            },
          ),
        );
      },
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', (error) => {
      cleanup();
      if (!resolved) reject(error);
    });
    const body = init?.body;
    if (body !== undefined && body !== null) {
      request.write(
        typeof body === 'string' ? body : Buffer.from(body as Uint8Array),
      );
    }
    request.end();
  });
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(
      'Remote MCP transport request aborted.',
      'AbortError',
    );
  }
  const error = new Error('Remote MCP transport request aborted.');
  error.name = 'AbortError';
  return error;
}

async function resolvePinnedPublicMcpAddressWithDeadline(
  hostname: string,
  lookupHostname: DnsPinnedHostnameLookup | undefined,
  signal: AbortSignal | null | undefined,
): Promise<{ address: string; family: 4 | 6 }> {
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
  const firstPublic = records.find(
    (record) => !isPrivateNetworkAddress(record.address),
  );
  if (
    records.length === 0 ||
    !firstPublic ||
    records.some((record) => isPrivateNetworkAddress(record.address))
  ) {
    throw new Error(
      'MCP server hostname must resolve only to public routable addresses.',
    );
  }
  return firstPublic;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
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
  for (const [key, value] of Object.entries(
    headers as Record<string, string>,
  )) {
    out[key] = value;
  }
  return out;
}

function responseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) out.append(key, entry);
    } else if (value !== undefined) {
      out.set(key, value);
    }
  }
  return out;
}

function toUrl(url: Parameters<typeof fetch>[0]): URL {
  if (typeof url === 'string') return new URL(url);
  if (url instanceof URL) return new URL(url.toString());
  return new URL((url as Request).url);
}
