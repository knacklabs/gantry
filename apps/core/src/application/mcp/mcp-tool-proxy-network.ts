import { isLoopbackAddress } from '../../domain/network/public-address-policy.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { evaluateEgressDenylist } from '../../shared/egress-policy.js';
import { createDnsPinnedMcpFetch } from '../../shared/dns-pinned-fetch.js';
import { ApplicationError } from '../common/application-error.js';

export function assertMcpNetworkHostAllowed(input: {
  serverName: string;
  url: string;
  denylist: readonly string[];
}): void {
  const parsed = new URL(input.url);
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  const hostLabel = `${hostname}:${parsed.port || defaultPortForProtocol(parsed.protocol)}`;
  const deny = evaluateEgressDenylist({
    settings: { denylist: [...input.denylist] },
    host: hostname,
  });
  if (deny) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Network access denied: MCP server ${input.serverName} host ${hostLabel} matches the egress denylist.`,
    );
  }
}

export function createGuardedMcpFetch(input: {
  allowLoopbackHttp?: boolean;
  lookupHostname?: HostnameLookup;
}): typeof fetch {
  const remoteFetch = createDnsPinnedMcpFetch({
    lookupHostname: input.lookupHostname,
  });
  // Remote MCP transports use a DNS-pinned fetch: the hostname is resolved once,
  // validated public, and the connection is pinned to that address with TLS SNI
  // bound to the hostname. This replaces the earlier IP-literal-only fail-closed
  // path so hostname-based remote MCP servers work without a rebinding window.
  return ((
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const target = new URL(
      typeof url === 'string' || url instanceof URL ? url : url.url,
    );
    if (input.allowLoopbackHttp && isLocalLoopbackHttpMcpUrl(target)) {
      return fetch(url, init);
    }
    return remoteFetch(url, init);
  }) as typeof fetch;
}

export function isLocalLoopbackHttpMcpUrl(url: URL): boolean {
  return url.protocol === 'http:' && isLoopbackAddress(url.hostname);
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === 'http:' ? '80' : '443';
}
