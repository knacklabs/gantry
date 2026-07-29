import { canonicalizeGeneratedRuntimeSkillPaths } from './generated-runtime-paths.js';
import { NEUTRAL_CA_TRUST_ENV_KEYS } from './neutral-ca-trust-env.js';

const GO_DNS_RUNTIME_ASSIGNMENT_RE = /^GODEBUG=netdns=go\s+/;
const TIMEZONE_RUNTIME_ASSIGNMENT_RE = /^TZ=[A-Za-z0-9_+./:-]+\s+/;
const NEUTRAL_CA_RUNTIME_VALUE_RE =
  /^(?:\$NODE_EXTRA_CA_CERTS|\$\{NODE_EXTRA_CA_CERTS\}|"[$]NODE_EXTRA_CA_CERTS"|"[$]\{NODE_EXTRA_CA_CERTS\}"|'[$]NODE_EXTRA_CA_CERTS'|'[$]\{NODE_EXTRA_CA_CERTS\}')\s+/;
const RUNTIME_NETWORK_ASSIGNMENT_KEYS = new Set([
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
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
]);

export function normalizeRuntimeOwnedBashCommandForMatching(
  command: string,
): string {
  let normalized = canonicalizeGeneratedRuntimeSkillPaths(
    command
      .trim()
      .replace(
        /(["']?)\$\{CLAUDE_PROJECT_DIR\}\/skills\//g,
        (_match, quote: string) => `${quote}skills/`,
      )
      .replace(
        /(["']?)\$CLAUDE_PROJECT_DIR\/skills\//g,
        (_match, quote: string) => `${quote}skills/`,
      ),
  );

  let sawRuntimePrefix = false;
  for (;;) {
    const next = stripOneRuntimeOwnedAssignment(normalized, sawRuntimePrefix);
    if (next === normalized) return normalized;
    if (GO_DNS_RUNTIME_ASSIGNMENT_RE.test(normalized)) {
      sawRuntimePrefix = true;
    }
    normalized = next.trimStart();
  }
}

function stripOneRuntimeOwnedAssignment(
  command: string,
  sawRuntimePrefix: boolean,
): string {
  const goDnsNext = command.replace(GO_DNS_RUNTIME_ASSIGNMENT_RE, '');
  if (goDnsNext !== command) return goDnsNext;
  const timezoneNext = command.replace(TIMEZONE_RUNTIME_ASSIGNMENT_RE, '');
  if (timezoneNext !== command) return timezoneNext;
  const networkNext = stripRuntimeNetworkAssignment(command, sawRuntimePrefix);
  if (networkNext !== command) return networkNext;
  for (const key of NEUTRAL_CA_TRUST_ENV_KEYS) {
    if (!command.startsWith(`${key}=`)) continue;
    const value = command.slice(key.length + 1);
    if (!NEUTRAL_CA_RUNTIME_VALUE_RE.test(value)) continue;
    return value.replace(NEUTRAL_CA_RUNTIME_VALUE_RE, '');
  }
  return command;
}

function stripRuntimeNetworkAssignment(
  command: string,
  sawRuntimePrefix: boolean,
): string {
  const assignment = readLeadingAssignment(command);
  if (!assignment) return command;
  const { key } = assignment;
  if (
    !key ||
    (!RUNTIME_NETWORK_ASSIGNMENT_KEYS.has(key) && !sawRuntimePrefix)
  ) {
    return command;
  }
  if (!assignment.quoted || assignment.hasShellExpansion) return command;
  return command.slice(assignment.end);
}

export function leadingAssignmentKeys(command: string): string[] {
  const keys: string[] = [];
  let rest = command.trimStart();
  for (;;) {
    const assignment = readLeadingAssignment(rest);
    if (!assignment) return keys;
    keys.push(assignment.key);
    rest = rest.slice(assignment.end).trimStart();
  }
}

function readLeadingAssignment(command: string): {
  key: string;
  end: number;
  quoted: boolean;
  hasShellExpansion: boolean;
} | null {
  const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(command);
  const key = keyMatch?.[1];
  if (!key) return null;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let quoted = false;
  let hasShellExpansion = false;
  for (let index = key.length + 1; index < command.length; index += 1) {
    const ch = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (ch === '$' || ch === '`')) {
        hasShellExpansion = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoted = true;
      quote = ch;
      continue;
    }
    if (ch === '$' || ch === '`') {
      hasShellExpansion = true;
    }
    if (/\s/.test(ch)) {
      return {
        key,
        end: index + 1,
        quoted,
        hasShellExpansion,
      };
    }
  }
  return null;
}
