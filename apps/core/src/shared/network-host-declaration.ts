export type DeclaredNetworkHostResult =
  { ok: true; host: string } | { ok: false; reason: string };

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

export function hostnameForNetwork(input: string): string {
  return input.startsWith('[') && input.endsWith(']')
    ? input.slice(1, -1)
    : input;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  return bytes.every((byte) => Number.isInteger(byte)) ? bytes : null;
}

function parseIpv6Bytes(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

  const ipv4Match = /(.+:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  let ipv4Groups: number[] = [];
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[2]!);
    if (!ipv4) return null;
    normalized = `${ipv4Match[1]}${((ipv4[0]! << 8) | ipv4[1]!).toString(
      16,
    )}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
    ipv4Groups = ipv4;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (segment: string): number[] => {
    if (!segment) return [];
    return segment.split(':').map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return Number.NaN;
      return parseInt(part, 16);
    });
  };
  const left = parseGroups(halves[0]!);
  const right = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (
    left.some((part) => !Number.isInteger(part)) ||
    right.some((part) => !Number.isInteger(part))
  ) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  if (ipv4Groups.length > 0) {
    bytes.splice(12, 4, ...ipv4Groups);
  }
  return bytes;
}

export function isIpAddress(address: string): boolean {
  const normalized = hostnameForNetwork(address).toLowerCase();
  return parseIpv4(normalized) !== null || parseIpv6Bytes(normalized) !== null;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = hostnameForNetwork(address).toLowerCase();
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a! >= 224) return true;
    return false;
  }

  const bytes = parseIpv6Bytes(normalized);
  if (!bytes) return true;
  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return true;
  const loopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (loopback) return true;
  const isMappedIpv4 =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (isMappedIpv4) {
    return isPrivateNetworkAddress(bytes.slice(12).join('.'));
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
    if (bytes[2] === 0x00 && bytes[3] === 0x02) return true;
    if (bytes[2] === 0x00 && (bytes[3]! & 0xf0) === 0x10) return true;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return true;
  }
  return false;
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
