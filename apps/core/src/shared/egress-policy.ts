import {
  isIpAddress,
  isPrivateNetworkAddress,
} from './network-host-declaration.js';

export interface EgressSettings {
  denylist: string[];
}

export interface EgressPolicyMatch {
  host: string;
  matchedPattern: string;
  reason: string;
}

const HOSTNAME_GLOB_PATTERN =
  /^(?:\*|\*\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:\*|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

export function normalizeEgressHost(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '')
    .toLowerCase();
}

export function validateEgressDenylistPattern(pattern: string): string {
  const normalized = normalizeEgressHost(pattern);
  if (!normalized) {
    throw new Error('must be a non-empty hostname glob');
  }
  if (
    normalized.includes('://') ||
    normalized.includes('/') ||
    normalized.includes(':') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    !HOSTNAME_GLOB_PATTERN.test(normalized)
  ) {
    throw new Error(
      'must be a hostname glob such as api.example.com or *.example.com',
    );
  }
  return normalized;
}

export function evaluateEgressDenylist(input: {
  settings: EgressSettings;
  host: string;
}): EgressPolicyMatch | undefined {
  const host = normalizeEgressHost(input.host);
  if (!host) return undefined;
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

export function evaluateNonPublicEgressAddress(input: {
  host: string;
  address: string;
}): EgressPolicyMatch | undefined {
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

function hostnameGlobMatches(pattern: string, host: string): boolean {
  if (!pattern.includes('*')) return pattern === host;
  const regex = new RegExp(
    `^${pattern.split('*').map(escapeRegex).join('.*')}$`,
    'i',
  );
  return regex.test(host);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
