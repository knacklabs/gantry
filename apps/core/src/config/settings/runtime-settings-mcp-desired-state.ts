import {
  assertValidCapabilitySecretName,
  normalizeCapabilitySecretName,
} from '../../domain/capability-secrets/capability-secrets.js';
import type {
  McpCredentialRef,
  McpServerTransportConfig,
} from '../../domain/mcp/mcp-servers.js';
import {
  hostnameForNetwork,
  isIpAddress,
  isLoopbackAddress,
  isPrivateNetworkAddress,
} from '../../domain/network/public-address-policy.js';
import { stableSha256Json } from '../../shared/stable-hash.js';
import type { RuntimeConfiguredMcpServer } from './runtime-settings-types.js';

const STDIO_TEMPLATE_IDS = new Set(['node-script', 'npx-package']);
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata']);
const MCP_CREDENTIAL_TARGET_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const MCP_CALLER_IDENTITY_JID_PREFIX_PATTERN = /^[a-z][a-z0-9_-]{0,31}:$/;
const MCP_TOOL_PATTERN = /^[A-Za-z0-9_.-]+(?:\*)?$/;
const NPM_PACKAGE_SPEC_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*+-][a-z0-9._~^*+-]*)?$/;

export function hashRuntimeMcpConfig(value: unknown): string {
  return `sha256:${stableSha256Json(value)}`;
}

export function normalizeRuntimeMcpCredentialRefs(
  refs: readonly McpCredentialRef[],
): McpCredentialRef[] {
  return refs.map((ref) => ({
    ...ref,
    name: normalizeCapabilitySecretName(ref.name),
  }));
}

export function validateRuntimeConfiguredMcpServer(
  server: RuntimeConfiguredMcpServer,
): void {
  validateTransportConfig(server.config, {
    sandboxProfileId: server.sandboxProfileId,
  });
  validateCredentialRefs(server.credentialRefs);
  validateToolPatternPolicy(server);
}

function validateTransportConfig(
  config: McpServerTransportConfig,
  options: { sandboxProfileId?: string } = {},
): void {
  validateCallerIdentityConfig(config);
  if (config.transport === 'http' || config.transport === 'sse') {
    if (!config.url) {
      throw new Error(`${config.transport} MCP server requires url.`);
    }
    const url = new URL(config.url);
    if (url.username || url.password) {
      throw new Error('MCP server URL must not include credentials.');
    }
    const hostnameForCheck = hostnameForNetwork(url.hostname);
    const isLoopbackUrl =
      isIpAddress(hostnameForCheck) && isLoopbackAddress(hostnameForCheck);
    const isLoopbackHttpUrl = url.protocol === 'http:' && isLoopbackUrl;
    if (url.protocol !== 'https:' && !isLoopbackHttpUrl) {
      throw new Error(
        'MCP server URL must use https (loopback http URLs like http://127.0.0.1 are exempt).',
      );
    }
    if (!isLoopbackHttpUrl) {
      assertSafeRemoteMcpHostname(url.hostname);
    }
    return;
  }
  if (config.transport === 'stdio_template') {
    if (!config.templateId || !STDIO_TEMPLATE_IDS.has(config.templateId)) {
      throw new Error(
        'stdio_template MCP server requires an approved templateId.',
      );
    }
    if (!options.sandboxProfileId) {
      throw new Error('stdio_template MCP server requires sandboxProfileId.');
    }
    validateStdioTemplateArgs(config);
    if (config.env && Object.keys(config.env).length > 0) {
      throw new Error('stdio_template MCP server env must use credentialRefs.');
    }
    return;
  }
  throw new Error('Unsupported MCP server transport.');
}

function validateCallerIdentityConfig(config: McpServerTransportConfig): void {
  const callerIdentity = config.callerIdentity;
  if (!callerIdentity) return;
  if (
    callerIdentity.mode !== 'disabled' &&
    callerIdentity.mode !== 'required'
  ) {
    throw new Error('MCP callerIdentity.mode must be disabled or required.');
  }
  if (
    callerIdentity.mode === 'required' &&
    config.transport !== 'http' &&
    config.transport !== 'sse'
  ) {
    throw new Error(
      'MCP callerIdentity is supported only for HTTP or SSE transports.',
    );
  }
  if (
    typeof callerIdentity.headerName !== 'string' ||
    !MCP_CREDENTIAL_TARGET_KEY_PATTERN.test(callerIdentity.headerName)
  ) {
    throw new Error(
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
  } catch (err) {
    throw new Error(
      `MCP callerIdentity signingRef must name a Gantry Secret environment variable: ${callerIdentity.signingRef}`,
      { cause: err },
    );
  }
  if (
    !callerIdentity.source ||
    callerIdentity.source.kind !== 'conversation_jid_phone'
  ) {
    throw new Error(
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
    throw new Error(
      'MCP callerIdentity.source.jidPrefix must be a lowercase JID prefix ending with ":".',
    );
  }
}

function validateCredentialRefs(refs: McpCredentialRef[]): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    try {
      assertValidCapabilitySecretName(normalizeCapabilitySecretName(ref.name));
    } catch (err) {
      throw new Error(
        `MCP credential ref must name a Gantry Secret environment variable: ${ref.name}`,
        { cause: err },
      );
    }
    if (!MCP_CREDENTIAL_TARGET_KEY_PATTERN.test(ref.key)) {
      throw new Error(`Invalid MCP credential target key: ${ref.key}`);
    }
    const key = `${ref.target}:${ref.key}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate MCP credential target: ${key}`);
    }
    seen.add(key);
  }
}

function validateToolPatternPolicy(server: RuntimeConfiguredMcpServer): void {
  const allowed = new Set(server.allowedToolPatterns);
  for (const pattern of [
    ...server.allowedToolPatterns,
    ...server.autoApproveToolPatterns,
  ]) {
    if (!MCP_TOOL_PATTERN.test(pattern)) {
      throw new Error(
        `Invalid MCP tool pattern: ${pattern}. Use exact tool names or suffix wildcard, e.g. read_*`,
      );
    }
  }
  for (const pattern of server.autoApproveToolPatterns) {
    if (!allowedHasPattern(allowed, pattern)) {
      throw new Error(
        `MCP auto-approve pattern ${pattern} must be covered by allowed_tool_patterns.`,
      );
    }
  }
}

function validateStdioTemplateArgs(config: McpServerTransportConfig): void {
  const args = config.args ?? [];
  if (config.templateId === 'npx-package') {
    if (args.length !== 1 || !NPM_PACKAGE_SPEC_PATTERN.test(args[0] ?? '')) {
      throw new Error(
        'npx-package MCP server requires exactly one safe npm package argument.',
      );
    }
    return;
  }
  if (args.length > 0) {
    throw new Error(
      'stdio_template MCP server args are only supported for npx-package in v1.',
    );
  }
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
    throw new Error('MCP server URL must not target local or metadata hosts.');
  }
  if (isIpAddress(normalized) && isPrivateNetworkAddress(normalized)) {
    throw new Error(
      'MCP server URL must not target private, loopback, link-local, or metadata addresses.',
    );
  }
}

function allowedHasPattern(allowed: Set<string>, autoPattern: string): boolean {
  if (allowed.has(autoPattern)) return true;
  for (const allowedPattern of allowed) {
    if (!allowedPattern.endsWith('*')) continue;
    const prefix = allowedPattern.slice(0, -1);
    if (autoPattern.startsWith(prefix)) return true;
  }
  return false;
}
