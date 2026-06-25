import { normalizeEgressHost } from '../shared/egress-policy.js';
import { declaredNetworkAuthority } from '../shared/network-host-declaration.js';
import type { EgressNetworkAttribution } from './egress-gateway.js';

export interface EgressAccessPolicyState {
  allowedPrivateAuthorities?: Set<string>;
  privateNetworkConnectHosts?: Map<string, string>;
}

export function networkAttributionMap(
  attribution: readonly EgressNetworkAttribution[] | undefined,
): Map<string, EgressNetworkAttribution> {
  const map = new Map<string, EgressNetworkAttribution>();
  for (const entry of attribution ?? []) {
    const authority = declaredNetworkAuthority(entry.host);
    if (authority && !map.has(authority)) map.set(authority, entry);
  }
  return map;
}

export function networkAuthoritySet(hosts: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const host of hosts) {
    const authority = declaredNetworkAuthority(host);
    if (authority) set.add(authority);
  }
  return set;
}

export function allowedPrivateEgressTarget(
  state: EgressAccessPolicyState,
  target: { host: string; port: number; authority: string },
):
  | { host: string; port: number; authority: string; connectHost?: string }
  | undefined {
  const authority = declaredNetworkAuthority(authorityWithPort(target));
  if (!authority || !state.allowedPrivateAuthorities?.has(authority)) {
    return undefined;
  }
  const host = normalizeEgressHost(target.host);
  return {
    host,
    port: target.port,
    authority: target.authority,
    connectHost: state.privateNetworkConnectHosts?.get(authority) ?? host,
  };
}

function authorityWithPort(target: { host: string; port: number }): string {
  const host =
    target.host.includes(':') && !target.host.startsWith('[')
      ? `[${target.host}]`
      : target.host;
  return `${host}:${target.port}`;
}
