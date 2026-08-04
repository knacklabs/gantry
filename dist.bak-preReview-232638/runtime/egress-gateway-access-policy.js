import { normalizeEgressHost } from '../shared/egress-policy.js';
import { declaredNetworkAuthority } from '../shared/network-host-declaration.js';
export function networkAttributionMap(attribution) {
    const map = new Map();
    for (const entry of attribution ?? []) {
        const authority = declaredNetworkAuthority(entry.host);
        if (authority && !map.has(authority))
            map.set(authority, entry);
    }
    return map;
}
export function mappedEgressTarget(state, target) {
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
function authorityWithPort(target) {
    const host = target.host.includes(':') && !target.host.startsWith('[')
        ? `[${target.host}]`
        : target.host;
    return `${host}:${target.port}`;
}
