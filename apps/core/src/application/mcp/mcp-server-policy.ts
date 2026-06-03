import type {
  McpCredentialRef,
  McpServerTransportConfig,
} from '../../domain/mcp/mcp-servers.js';
import {
  assertValidCapabilitySecretName,
  normalizeCapabilitySecretName,
} from '../../domain/capability-secrets/capability-secrets.js';
import {
  hostnameForNetwork,
  isIpAddress,
  isLoopbackAddress,
  isPrivateNetworkAddress,
  type HostnameLookup,
} from '../../domain/network/public-address-policy.js';
import {
  declaredNetworkAuthority,
  parseDeclaredNetworkHost,
} from '../../shared/network-host-declaration.js';
import { normalizeMcpToolScope } from '../../shared/mcp-tool-scope.js';
import { lookupHostnameWithDeadline } from '../../shared/hostname-lookup-deadline.js';
import { ApplicationError } from '../common/application-error.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

const DEFAULT_REMOTE_DNS_CACHE_TTL_MS = 1_000;
const REMOTE_MCP_DNS_LOOKUP_TIMEOUT_MS = 60_000;

export const STDIO_TEMPLATE_COMMANDS: Record<
  string,
  { command: string; args: string[] }
> = {
  'node-script': { command: 'node', args: [] },
  'npx-package': { command: 'npx', args: ['-y'] },
};

const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata']);
const MCP_CREDENTIAL_TARGET_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const NPM_PACKAGE_SPEC_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*+-][a-z0-9._~^*+-]*)?$/;

/**
 * Validate and normalize declared MCP server network hosts. Third-party MCP
 * source install/bind is inventory only; approved tool patterns define operation
 * authority, while declared hosts are review/audit metadata. For remote http/sse
 * servers the configured URL host is added automatically when omitted so review
 * prompts and audit can show the connection target.
 */
export function normalizeMcpNetworkHosts(input: {
  serverName: string;
  networkHosts: readonly string[] | undefined;
  config: McpServerTransportConfig;
}): string[] {
  const hosts = new Set<string>();
  for (const value of input.networkHosts ?? []) {
    const result = parseDeclaredNetworkHost(value);
    if (!result.ok) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP server ${input.serverName} networkHosts ${result.reason}`,
      );
    }
    hosts.add(result.host);
  }
  if (
    (input.config.transport === 'http' || input.config.transport === 'sse') &&
    input.config.url
  ) {
    const url = new URL(input.config.url);
    const port = url.port || defaultPortForProtocol(url.protocol);
    const urlHost = `${url.hostname.toLowerCase().replace(/\.+$/, '')}:${port}`;
    const alreadyDeclared = [...hosts].some(
      (host) =>
        declaredNetworkAuthority(host) === declaredNetworkAuthority(urlHost),
    );
    if (!alreadyDeclared) hosts.add(urlHost);
  }
  return [...hosts];
}

/**
 * Validate and normalize a per-agent MCP tool scope. Each requested pattern must
 * be covered by the server definition's reviewed `allowedToolPatterns`, so a
 * binding can only narrow (e.g. read-only) — never widen beyond what was
 * reviewed. Empty means the agent inherits the definition's full set.
 */
export function normalizeAgentMcpToolScope(input: {
  serverName: string;
  requested: readonly string[] | undefined;
  definitionPatterns: readonly string[];
}): string[] {
  try {
    return normalizeMcpToolScope(input);
  } catch (err) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function validateTransportConfig(
  config: McpServerTransportConfig,
  options: { sandboxProfileId?: string } = {},
): void {
  if (config.transport === 'http' || config.transport === 'sse') {
    if (!config.url) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${config.transport} MCP server requires url.`,
      );
    }
    const url = new URL(config.url);
    if (url.username || url.password) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'MCP server URL must not include credentials.',
      );
    }
    const localLoopbackHttp =
      url.protocol === 'http:' && isLoopbackAddress(url.hostname);
    if (url.protocol !== 'https:' && !localLoopbackHttp) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'MCP server URL must use https unless it targets a loopback IP over http.',
      );
    }
    if (!localLoopbackHttp) assertSafeRemoteMcpHostname(url.hostname);
    return;
  }
  if (config.transport === 'stdio_template') {
    if (!config.templateId || !STDIO_TEMPLATE_COMMANDS[config.templateId]) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'stdio_template MCP server requires an approved templateId.',
      );
    }
    if (!options.sandboxProfileId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'stdio_template MCP server requires sandboxProfileId.',
      );
    }
    validateStdioTemplateArgs(config);
    if (config.env && Object.keys(config.env).length > 0) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'stdio_template MCP server env must use credentialRefs.',
      );
    }
    return;
  }
  throw new ApplicationError(
    'INVALID_REQUEST',
    'Unsupported MCP server transport.',
  );
}

export async function assertRemoteMcpDestinationPublic(
  config: McpServerTransportConfig,
  lookupHostname?: HostnameLookup,
  options: {
    cache?: RemoteMcpDnsValidationCache;
    nowMs?: number;
    ttlMs?: number;
    lookupTimeoutMs?: number;
  } = {},
): Promise<void> {
  if (config.transport !== 'http' && config.transport !== 'sse') return;
  if (!config.url) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `${config.transport} MCP server requires url.`,
    );
  }
  const hostname = hostnameForNetwork(new URL(config.url).hostname)
    .trim()
    .toLowerCase();
  if (isIpAddress(hostname)) return;
  const cache = options.cache;
  const nowMs = options.nowMs ?? currentTimeMs();
  const ttlMs = options.ttlMs ?? DEFAULT_REMOTE_DNS_CACHE_TTL_MS;
  if (cache) {
    const cached = cache.get(hostname);
    if (cached && cached.expiresAtMs > nowMs) return;
    if (cached) cache.delete(hostname);
    const pending = cache.getPending(hostname);
    if (pending) return pending;
  }
  if (!lookupHostname) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP server hostname did not resolve to a public address.',
    );
  }
  const validation = validateRemoteMcpHostname(
    hostname,
    lookupHostname,
    options.lookupTimeoutMs ?? REMOTE_MCP_DNS_LOOKUP_TIMEOUT_MS,
  );
  if (cache) {
    cache.setPending(hostname, validation);
  }
  await validation;
  cache?.set(hostname, { expiresAtMs: nowMs + ttlMs });
}

async function validateRemoteMcpHostname(
  hostname: string,
  lookupHostname: HostnameLookup,
  lookupTimeoutMs: number,
): Promise<void> {
  let records;
  try {
    records = await lookupHostnameWithDeadline({
      hostname,
      lookupHostname,
      timeoutMs: lookupTimeoutMs,
      timeoutMessage: 'MCP server hostname did not resolve before timeout.',
    });
  } catch {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP server hostname did not resolve to a public address.',
    );
  }
  if (records.length === 0) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP server hostname did not resolve to a public address.',
    );
  }
  if (
    records.some((record) => isPrivateNetworkAddress(record.address)) ||
    !records.some((record) => !isPrivateNetworkAddress(record.address))
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP server hostname must resolve only to public routable addresses.',
    );
  }
}

function validateStdioTemplateArgs(config: McpServerTransportConfig): void {
  const args = config.args ?? [];
  if (config.templateId === 'npx-package') {
    if (args.length !== 1 || !NPM_PACKAGE_SPEC_PATTERN.test(args[0] ?? '')) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'npx-package MCP server requires exactly one safe npm package argument.',
      );
    }
    return;
  }
  if (args.length > 0) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'stdio_template MCP server args are only supported for npx-package in v1.',
    );
  }
}

export class RemoteMcpDnsValidationCache {
  private readonly cache = new Map<string, { expiresAtMs: number }>();
  private readonly pending = new Map<string, Promise<void>>();

  get(hostname: string): { expiresAtMs: number } | undefined {
    return this.cache.get(hostname);
  }

  set(hostname: string, entry: { expiresAtMs: number }): void {
    this.cache.set(hostname, entry);
  }

  delete(hostname: string): void {
    this.cache.delete(hostname);
  }

  getPending(hostname: string): Promise<void> | undefined {
    return this.pending.get(hostname);
  }

  setPending(hostname: string, promise: Promise<void>): void {
    const pending = promise.finally(() => {
      this.pending.delete(hostname);
    });
    pending.catch(() => undefined);
    this.pending.set(hostname, pending);
  }
}

export function validateCredentialRefs(refs: McpCredentialRef[]): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    try {
      assertValidCapabilitySecretName(normalizeCapabilitySecretName(ref.name));
    } catch {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `MCP credential ref must name a Gantry Credential environment variable: ${ref.name}`,
      );
    }
    if (!MCP_CREDENTIAL_TARGET_KEY_PATTERN.test(ref.key)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Invalid MCP credential target key: ${ref.key}`,
      );
    }
    const key = `${ref.target}:${ref.key}`;
    if (seen.has(key)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Duplicate MCP credential target: ${key}`,
      );
    }
    seen.add(key);
  }
}

export function normalizeCredentialRefs(
  refs: readonly McpCredentialRef[],
): McpCredentialRef[] {
  return refs.map((ref) => ({
    ...ref,
    name: normalizeCapabilitySecretName(ref.name),
  }));
}

function assertSafeRemoteMcpHostname(hostname: string): void {
  const normalized = hostnameForNetwork(hostname)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    METADATA_HOSTNAMES.has(normalized)
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP server URL must not target local or metadata hosts.',
    );
  }
  if (isIpAddress(normalized) && isPrivateNetworkAddress(normalized)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP server URL must not target private, loopback, link-local, or metadata addresses.',
    );
  }
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === 'http:' ? '80' : '443';
}
