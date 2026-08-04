import { normalizeEgressHost } from '../shared/egress-policy.js';
import { declaredNetworkAuthority } from '../shared/network-host-declaration.js';
import type { EgressNetworkAttribution } from './egress-gateway.js';

export interface EgressAccessPolicyState {
  connectHostMappings?: Map<string, string>;
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

export function mappedEgressTarget(
  state: EgressAccessPolicyState,
  target: { host: string; port: number; authority: string },
):
  | { host: string; port: number; authority: string; connectHost?: string }
  | undefined {
  const authority = declaredNetworkAuthority(authorityWithPort(target));
  const connectHost = authority
    ? state.connectHostMappings?.get(authority)
    : undefined;
  if (!authority || !connectHost) {
    return undefined;
  }
  const host = normalizeEgressHost(target.host);
  return {
    host,
    port: target.port,
    authority: target.authority,
    connectHost,
  };
}

function authorityWithPort(target: { host: string; port: number }): string {
  const host =
    target.host.includes(':') && !target.host.startsWith('[')
      ? `[${target.host}]`
      : target.host;
  return `${host}:${target.port}`;
}
