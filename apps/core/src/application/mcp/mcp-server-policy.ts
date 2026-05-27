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
import { ApplicationError } from '../common/application-error.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';

const DEFAULT_REMOTE_DNS_CACHE_TTL_MS = 1_000;

export const STDIO_TEMPLATE_COMMANDS: Record<
  string,
  { command: string; args: string[] }
> = {
  'node-script': { command: 'node', args: [] },
  'npx-package': { command: 'npx', args: ['-y'] },
};

const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata']);
const MCP_CREDENTIAL_TARGET_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const MCP_CALLER_IDENTITY_JID_PREFIX_PATTERN = /^[a-z][a-z0-9_-]{0,31}:$/;
const NPM_PACKAGE_SPEC_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*+-][a-z0-9._~^*+-]*)?$/;

export function validateTransportConfig(
  config: McpServerTransportConfig,
  options: { sandboxProfileId?: string } = {},
): void {
  validateCallerIdentityConfig(config);
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
    const hostnameForCheck = hostnameForNetwork(url.hostname);
    const isLoopbackUrl =
      isIpAddress(hostnameForCheck) && isLoopbackAddress(hostnameForCheck);
    const isLoopbackHttpUrl = url.protocol === 'http:' && isLoopbackUrl;
    if (url.protocol !== 'https:') {
      // Allow http only for IPv4 127.0.0.0/8 or IPv6 ::1. TLS is meaningless
      // on the loopback interface, while all non-loopback URLs still require
      // https.
      if (!isLoopbackHttpUrl) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          'MCP server URL must use https (loopback http URLs like http://127.0.0.1 are exempt).',
        );
      }
    }
    // Only the explicit http loopback exception bypasses remote-host checks.
    if (!isLoopbackHttpUrl) {
      assertSafeRemoteMcpHostname(url.hostname);
    }
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

function validateCallerIdentityConfig(config: McpServerTransportConfig): void {
  const callerIdentity = config.callerIdentity;
  if (!callerIdentity) return;
  if (
    callerIdentity.mode !== 'disabled' &&
    callerIdentity.mode !== 'required'
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP callerIdentity.mode must be disabled or required.',
    );
  }
  if (
    callerIdentity.mode === 'required' &&
    config.transport !== 'http' &&
    config.transport !== 'sse'
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP callerIdentity is supported only for HTTP or SSE transports.',
    );
  }
  if (
    typeof callerIdentity.headerName !== 'string' ||
    !MCP_CREDENTIAL_TARGET_KEY_PATTERN.test(callerIdentity.headerName)
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `Invalid MCP callerIdentity header name: ${callerIdentity.headerName}`,
    );
  }
  try {
    assertValidCapabilitySecretName(
      normalizeCapabilitySecretName(
        typeof callerIdentity.signingRef === 'string'
          ? callerIdentity.signingRef
          : '',
      ),
    );
  } catch {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `MCP callerIdentity signingRef must name a Gantry Secret environment variable: ${callerIdentity.signingRef}`,
    );
  }
  if (
    !callerIdentity.source ||
    callerIdentity.source.kind !== 'conversation_jid_phone'
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP callerIdentity.source.kind must be conversation_jid_phone.',
    );
  }
  if (
    !MCP_CALLER_IDENTITY_JID_PREFIX_PATTERN.test(
      typeof callerIdentity.source.jidPrefix === 'string'
        ? callerIdentity.source.jidPrefix
        : '',
    )
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'MCP callerIdentity.source.jidPrefix must be a lowercase JID prefix ending with ":".',
    );
  }
}

export async function assertRemoteMcpDestinationPublic(
  config: McpServerTransportConfig,
  lookupHostname?: HostnameLookup,
  options: {
    cache?: RemoteMcpDnsValidationCache;
    nowMs?: number;
    ttlMs?: number;
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
  const validation = validateRemoteMcpHostname(hostname, lookupHostname);
  if (cache) {
    cache.setPending(hostname, validation);
  }
  await validation;
  cache?.set(hostname, { expiresAtMs: nowMs + ttlMs });
}

async function validateRemoteMcpHostname(
  hostname: string,
  lookupHostname: HostnameLookup,
): Promise<void> {
  let records;
  try {
    records = await lookupHostname(hostname);
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
    this.pending.set(
      hostname,
      promise.finally(() => {
        this.pending.delete(hostname);
      }),
    );
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
        `MCP credential ref must name a Gantry Secret environment variable: ${ref.name}`,
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
