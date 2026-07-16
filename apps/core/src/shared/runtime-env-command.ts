import { NEUTRAL_CA_TRUST_ENV_KEYS } from './neutral-ca-trust-env.js';

export const RUNTIME_ENV_ASSIGNMENT_KEYS = new Set([
  'GODEBUG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'GRPC_PROXY',
  'grpc_proxy',
  'GIT_SSH_COMMAND',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'no_proxy',
]);

const HOST_PROXY_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
]);
const HOST_NO_PROXY_ENV_KEYS = new Set(['NO_PROXY', 'no_proxy']);
const LOOPBACK_PROXY_URL_RE =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?\/?$/;
const LOOPBACK_NO_PROXY_TOKENS = new Set(['127.0.0.1', 'localhost', '::1']);
const NEUTRAL_CA_TRUST_ENV_KEY_SET = new Set<string>(NEUTRAL_CA_TRUST_ENV_KEYS);

export function stripRuntimeEnvPrefix(command: string): {
  command: string;
  envAssignments: string[];
} {
  const parsed = splitRuntimeEnvAssignments(command, ({ key }) =>
    RUNTIME_ENV_ASSIGNMENT_KEYS.has(key),
  );
  if (!parsed || !parsed.command.trim()) {
    return { command, envAssignments: [] };
  }
  return {
    command: parsed.command.trim(),
    envAssignments: parsed.assignments,
  };
}

export function stripHostInjectedEnvPrefix(command: string): {
  command: string;
  strippedAssignments: string[];
} {
  const parsed = splitRuntimeEnvAssignments(command, isHostInjectedAssignment);
  if (!parsed || !parsed.command.trim()) {
    return { command, strippedAssignments: [] };
  }
  return {
    command: parsed.command,
    strippedAssignments: parsed.assignments,
  };
}

function isHostInjectedAssignment({
  key,
  shellWordComplete,
  value,
}: RuntimeEnvAssignment): boolean {
  if (!shellWordComplete) return false;
  if (key === 'GODEBUG') return value === 'netdns=go';
  if (HOST_PROXY_ENV_KEYS.has(key)) return isLoopbackProxyUrl(value);
  if (HOST_NO_PROXY_ENV_KEYS.has(key)) {
    const tokens = value.split(',').map((token) => token.trim());
    return (
      tokens.length > 0 &&
      tokens.every(
        (token) => token.length > 0 && LOOPBACK_NO_PROXY_TOKENS.has(token),
      )
    );
  }
  if (key === 'NODE_USE_ENV_PROXY') return value === '1';
  if (!NEUTRAL_CA_TRUST_ENV_KEY_SET.has(key)) return false;
  const trustedValues = [process.env.NODE_EXTRA_CA_CERTS, process.env[key]]
    .map((trustedValue) => trustedValue?.trim())
    .filter((trustedValue): trustedValue is string => Boolean(trustedValue));
  return trustedValues.includes(value);
}

function isLoopbackProxyUrl(value: string): boolean {
  const match = LOOPBACK_PROXY_URL_RE.exec(value);
  if (!match) return false;
  return match[1] === undefined || Number(match[1]) <= 65_535;
}

interface RuntimeEnvAssignment {
  key: string;
  shellWordComplete: boolean;
  value: string;
  nextOffset: number;
}

function splitRuntimeEnvAssignments(
  command: string,
  shouldStrip: (assignment: RuntimeEnvAssignment) => boolean,
): { command: string; assignments: string[] } | null {
  let offset = 0;
  const assignments: string[] = [];
  while (offset < command.length) {
    const next = parseRuntimeEnvAssignment(command, offset);
    if (!next || !shouldStrip(next)) break;
    assignments.push(
      command.slice(skipSpaces(command, offset), next.nextOffset).trim(),
    );
    offset = next.nextOffset;
  }
  if (assignments.length === 0) return null;
  return { command: command.slice(offset), assignments };
}

function parseRuntimeEnvAssignment(
  command: string,
  offset: number,
): RuntimeEnvAssignment | null {
  let cursor = skipSpaces(command, offset);
  const keyMatch = command.slice(cursor).match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!keyMatch?.[1]) return null;
  cursor += keyMatch[0].length;
  const parsedValue = parseShellAssignmentValue(command, cursor);
  if (!parsedValue || parsedValue.nextOffset === cursor) return null;
  return {
    key: keyMatch[1],
    shellWordComplete:
      parsedValue.nextOffset === command.length ||
      /[\s;|&<>()]/.test(command[parsedValue.nextOffset] ?? ''),
    value: parsedValue.value,
    nextOffset: skipSpaces(command, parsedValue.nextOffset),
  };
}

function parseShellAssignmentValue(
  command: string,
  offset: number,
): { nextOffset: number; value: string } | null {
  const quote = command[offset];
  if (quote === "'" || quote === '"') {
    let cursor = offset + 1;
    while (cursor < command.length) {
      if (command[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (command[cursor] === quote) {
        return {
          nextOffset: cursor + 1,
          value: command.slice(offset + 1, cursor),
        };
      }
      cursor += 1;
    }
    return null;
  }
  let cursor = offset;
  while (
    cursor < command.length &&
    !/[\s;|&<>()]/.test(command[cursor] ?? '')
  ) {
    cursor += 1;
  }
  return { nextOffset: cursor, value: command.slice(offset, cursor) };
}

function skipSpaces(command: string, offset: number): number {
  let cursor = offset;
  while (cursor < command.length && /\s/.test(command[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}
