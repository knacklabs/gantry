import { isIpAddress, isPrivateNetworkAddress, } from './network-host-declaration.js';
const HOSTNAME_GLOB_PATTERN = /^(?:\*|\*\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:\*|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
export function normalizeEgressHost(host) {
    return host
        .trim()
        .replace(/^\[|\]$/g, '')
        .replace(/\.+$/g, '')
        .toLowerCase();
}
export function validateEgressDenylistPattern(pattern) {
    const normalized = normalizeEgressHost(pattern);
    if (!normalized) {
        throw new Error('must be a non-empty hostname glob');
    }
    if (normalized.includes('://') ||
        normalized.includes('/') ||
        normalized.includes(':') ||
        normalized.includes('?') ||
        normalized.includes('#') ||
        !HOSTNAME_GLOB_PATTERN.test(normalized)) {
        throw new Error('must be a hostname glob such as api.example.com or *.example.com');
    }
    return normalized;
}
export function evaluateEgressDenylist(input) {
    const host = normalizeEgressHost(input.host);
    if (!host)
        return undefined;
    for (const pattern of input.settings.denylist) {
        const normalizedPattern = normalizeEgressHost(pattern);
        if (hostnameGlobMatches(normalizedPattern, host)) {
            return {
                host,
                matchedPattern: pattern,
                reason: `Host ${host} matched permissions.egress.denylist pattern ${pattern}.`,
            };
        }
    }
    return undefined;
}
export function evaluateNonPublicEgressAddress(input) {
    const address = normalizeEgressHost(input.address);
    if (!isIpAddress(address) || !isPrivateNetworkAddress(address)) {
        return undefined;
    }
    const host = normalizeEgressHost(input.host);
    return {
        host,
        matchedPattern: 'non-public-address',
        reason: `Host ${host} resolved to non-public address ${address}.`,
    };
}
function hostnameGlobMatches(pattern, host) {
    if (!pattern.includes('*'))
        return pattern === host;
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
    return regex.test(host);
}
function escapeRegex(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
