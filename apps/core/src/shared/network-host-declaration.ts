import {
  hostnameForNetwork,
  isIpAddress,
  isPrivateNetworkAddress,
} from './public-address-policy.js';

export {
  hostnameForNetwork,
  isIpAddress,
  isPrivateNetworkAddress,
} from './public-address-policy.js';

export type DeclaredNetworkHostResult =
  | { ok: true; host: string }
  | { ok: false; reason: string };

/**
 * Validate and normalize a single declared outbound network target.
 *
 * Declared hosts are exact `host` or `host:port` values. This is the shared
 * authority parser for skill-action and third-party MCP network declarations:
 * it rejects URLs, schemes, paths, credentials, wildcards, empty hosts, invalid
 * ports, and localhost/private/loopback targets, then lowercases, strips
 * trailing dots, and returns a canonical value safe to dedupe. Callers prefix
 * the `reason` with their own subject (for example
 * `Skill action <id> networkHosts <reason>`).
 */
export function parseDeclaredNetworkHost(
  value: string,
): DeclaredNetworkHostResult {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return fail('entries cannot be empty.');
  if (/\s/.test(trimmed)) return fail('entries cannot contain whitespace.');
  if (
    trimmed.includes('://') ||
    trimmed.includes('@') ||
    trimmed.includes('/') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return fail(
      'must be host or host:port values, not URLs, schemes, or paths.',
    );
  }
  if (trimmed.includes('*')) return fail('cannot use wildcards.');
  const split = splitHostPort(trimmed);
  if (!split.ok) return split;
  const { host, port } = split;
  if (!host) return fail('must include a hostname.');
  if (
    port !== undefined &&
    (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
  ) {
    return fail('port must be an integer between 1 and 65535.');
  }
  const bareHost = hostnameForNetwork(host).replace(/\.+$/, '');
  if (!bareHost) return fail('must include a hostname.');
  if (bareHost === 'localhost' || bareHost.endsWith('.localhost')) {
    return fail('cannot target localhost.');
  }
  if (isIpAddress(bareHost)) {
    if (isPrivateNetworkAddress(bareHost)) {
      return fail('cannot target private, loopback, or link-local addresses.');
    }
  } else if (!isValidHostnameLabels(bareHost)) {
    return fail('must be a valid hostname.');
  }
  const canonicalHost = isIpAddress(bareHost) ? host : bareHost;
  return {
    ok: true,
    host: port !== undefined ? `${canonicalHost}:${port}` : canonicalHost,
  };
}

/**
 * The exact network authority (`host:port`) represented by a declared or
 * observed network host. Missing ports default to 443 because these declarations
 * authorize outbound HTTPS/API access rather than arbitrary port access.
 */
export function declaredNetworkAuthority(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const split = splitHostPort(trimmed);
  if (!split.ok) return undefined;
  const bare = hostnameForNetwork(split.host).replace(/\.+$/, '');
  if (!bare) return undefined;
  return `${bare}:${split.port || '443'}`;
}

function splitHostPort(
  value: string,
): { ok: true; host: string; port?: string } | { ok: false; reason: string } {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return fail('bracketed IPv6 hosts must close the bracket.');
    const host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (!rest) return { ok: true, host };
    if (!rest.startsWith(':')) {
      return fail('must be host or host:port values.');
    }
    return { ok: true, host, port: rest.slice(1) };
  }
  const firstColon = value.indexOf(':');
  if (firstColon === -1) return { ok: true, host: value };
  if (firstColon !== value.lastIndexOf(':')) {
    return fail('IPv6 hosts must be bracketed, for example [2001:db8::1]:443.');
  }
  return {
    ok: true,
    host: value.slice(0, firstColon),
    port: value.slice(firstColon + 1),
  };
}

function isValidHostnameLabels(host: string): boolean {
  if (!host || host.length > 253) return false;
  return host
    .split('.')
    .every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
