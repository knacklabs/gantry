import path from 'path';

import { validateAgentToolRuntimeRules } from '../application/agents/agent-tool-runtime-rules.js';
import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import type { MaterializedMcpServer } from '../domain/mcp/mcp-servers.js';
import type { EgressNetworkAttribution } from './egress-gateway.js';
import type { AgentInput } from './agent-spawn-types.js';
import {
  reviewedExternalMcpToolNamesFromRuntimeAccess,
  type CapabilityRuntimeAccess,
} from '../shared/capability-runtime-access.js';
import { DEEPAGENTS_ENGINE, type AgentEngine } from '../shared/agent-engine.js';
import { listExecutableModelProviders } from '../shared/model-provider-registry.js';
import {
  filterMcpToolNamesBySourceScopes,
  reviewedMcpToolPatterns,
} from '../shared/mcp-tool-scope.js';

export const PROTECTED_FILESYSTEM_PATHS_ENV =
  'GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON';
export const PROTECTED_FILESYSTEM_DENY_READ_PATHS_ENV =
  'GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON';
export const PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_ENV =
  'GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON';
export const LOCAL_CLI_CREDENTIAL_DIRS_ENV =
  'GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON';
export const SANDBOX_RUNTIME_MODEL_GATEWAY_HOST =
  'model-gateway.gantry.internal';

export interface SandboxRuntimeModelGatewayProjection {
  modelCredentialEnv?: Record<string, string>;
  allowedNetworkHosts: string[];
  privateNetworkHostMappings: Array<{
    authority: string;
    connectHost: string;
  }>;
}

const SAFE_HOST_ENV_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'NO_PROXY',
  'no_proxy',
] as const;
const PREPARED_EXECUTION_ENV_DENYLIST = new Set([
  'PATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'NODE_EXTRA_CA_CERTS',
]);
const PREPARED_EXECUTION_GANTRY_ENV_ALLOWLIST = new Set([
  'GANTRY_EFFECTIVE_MODEL_SOURCE',
  'GANTRY_CLAUDE_SDK_SKILLS_JSON',
  'GANTRY_SKILL_ACTIONS_JSON',
]);
const PREPARED_EXECUTION_ENV_SUFFIX_ALLOWLIST = ['_CONFIG_DIR', '_MODEL'];
const PREPARED_EXECUTION_SECRET_ENV_PATTERN =
  /(?:^|_)(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i;

export interface ResolvedRunnerMcpProjection {
  reviewedMcpToolNames: string[];
  projectedMcpSourceIds: string[];
}

export function validateRunnerAllowedTools(
  rules: readonly string[],
  runtimeAccess: AgentInput['runtimeAccess'] = [],
): string | null {
  try {
    const reviewedExternalMcpTools = new Set(
      reviewedExternalMcpToolNamesFromRuntimeAccess(runtimeAccess),
    );
    const unreviewedExternalMcpTool = rules.find((rule) => {
      const trimmed = rule.trim();
      return (
        /^mcp__(?!gantry__)[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/.test(trimmed) &&
        !reviewedExternalMcpTools.has(trimmed)
      );
    });
    if (unreviewedExternalMcpTool) {
      return `Configured agent tool ${unreviewedExternalMcpTool} is invalid. Third-party MCP tool names must be projected from a reviewed semantic capability.`;
    }
    validateAgentToolRuntimeRules({
      rules,
      errorSubject: 'Configured agent tool',
      allowProjectedThirdPartyMcpTools: true,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function pickSafeHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_HOST_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

export function pickPreparedExecutionEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!isPreparedExecutionEnvKeyAllowed(key)) continue;
    env[key] = value;
  }
  return env;
}

export function pickSelectedCapabilityEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (PREPARED_EXECUTION_ENV_DENYLIST.has(key) || key.startsWith('GANTRY_')) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export function resolveHomeRelativePaths(
  values: readonly string[],
  source: NodeJS.ProcessEnv,
): string[] {
  const home = source.HOME ?? source.USERPROFILE;
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed === '~') {
      if (home) out.add(home);
      continue;
    }
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      if (home) out.add(path.join(home, trimmed.slice(2)));
      continue;
    }
    const expanded = expandCredentialPathTemplate(trimmed, source);
    if (expanded) out.add(expanded);
  }
  return [...out];
}

export function localCliCredentialPathHintsFromRuntimeAccess(
  runtimeAccess: AgentInput['runtimeAccess'],
): string[] {
  const dirs = (runtimeAccess ?? []).flatMap((access) =>
    access.sourceType === 'local_cli' ? access.credentialDirs : [],
  );
  return [...new Set(dirs.map((dir) => dir.trim()).filter(Boolean))];
}

export function egressNetworkAttributionFromRuntimeAccess(
  runtimeAccess: AgentInput['runtimeAccess'],
): EgressNetworkAttribution[] {
  const attribution: EgressNetworkAttribution[] = [];
  for (const access of runtimeAccess ?? []) {
    if (
      access.sourceType === 'local_cli' ||
      access.sourceType === 'skill_action'
    ) {
      for (const binding of access.networkBindings ?? []) {
        for (const host of binding.hosts ?? []) {
          pushAttribution(attribution, host, access);
        }
      }
      continue;
    }
    if (access.sourceType === 'mcp_server') {
      for (const host of access.networkHosts ?? []) {
        pushAttribution(attribution, host, access);
      }
    }
  }
  return attribution;
}

export function attachMcpSourceNetworkHosts(
  runtimeAccess: readonly CapabilityRuntimeAccess[],
  capabilities: readonly MaterializedMcpCapability[],
): CapabilityRuntimeAccess[] {
  const hostsByServer = new Map(
    capabilities.map((capability) => [
      capability.name,
      capability.networkHosts,
    ]),
  );
  return runtimeAccess.map((access) => {
    if (access.sourceType !== 'mcp_server') return access;
    const serverName = mcpServerNameFromRuntimeAccess(access);
    const sourceHosts = serverName ? hostsByServer.get(serverName) : undefined;
    if (!sourceHosts?.length) return access;
    return {
      ...access,
      networkHosts: [...new Set([...access.networkHosts, ...sourceHosts])],
    };
  });
}

export function resolveRunnerMcpProjection(
  agentEngine: AgentEngine,
  input: {
    runtimeAccess: readonly CapabilityRuntimeAccess[];
    mcpSourceRecords: readonly MaterializedMcpServer[];
  },
): ResolvedRunnerMcpProjection {
  const mcpSourceScopes = input.mcpSourceRecords.map(
    ({ definition, binding }) => ({
      name: definition.name,
      allowedToolPatterns:
        binding.allowedToolPatterns.length > 0
          ? binding.allowedToolPatterns
          : reviewedMcpToolPatterns(definition),
    }),
  );
  const sourceScopedReviewedMcpToolNames = filterMcpToolNamesBySourceScopes(
    reviewedExternalMcpToolNamesFromRuntimeAccess(input.runtimeAccess, {
      serverNames: mcpSourceScopes.map((scope) => scope.name),
    }),
    mcpSourceScopes,
  );
  const reviewedMcpServerNames = new Set(
    sourceScopedReviewedMcpToolNames.flatMap((toolName) => {
      const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName.trim());
      return match?.[1] ? [match[1]] : [];
    }),
  );
  const directMcpSourceRecords = input.mcpSourceRecords.filter(
    ({ definition }) =>
      reviewedMcpServerNames.has(definition.name) &&
      canProjectThirdPartyMcpSourceToRunner(definition, agentEngine),
  );
  const directMcpServerNames = new Set(
    directMcpSourceRecords.map(({ definition }) => definition.name),
  );
  return {
    reviewedMcpToolNames: sourceScopedReviewedMcpToolNames.filter(
      (toolName) => {
        const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName.trim());
        return match?.[1] ? directMcpServerNames.has(match[1]) : false;
      },
    ),
    projectedMcpSourceIds: directMcpSourceRecords.map(
      ({ definition }) => definition.id,
    ),
  };
}

function canProjectThirdPartyMcpSourceToRunner(
  definition: MaterializedMcpServer['definition'],
  agentEngine: AgentEngine,
): boolean {
  if (agentEngine === DEEPAGENTS_ENGINE) return false;
  return definition.transport === 'stdio_template';
}

export function sandboxAllowedNetworkHostsFromRuntimeAccess(
  runtimeAccess: readonly CapabilityRuntimeAccess[],
): string[] {
  const hosts = new Set<string>();
  for (const access of runtimeAccess) {
    if (access.sourceType === 'mcp_server') {
      for (const host of access.networkHosts) hosts.add(host);
      continue;
    }
    if (
      access.sourceType === 'local_cli' ||
      access.sourceType === 'skill_action'
    ) {
      for (const binding of access.networkBindings ?? []) {
        for (const host of binding.hosts) hosts.add(host);
      }
    }
  }
  return [...hosts].sort();
}

export function loopbackAuthorityFromUrl(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      return undefined;
    }
    const port = parsed.port || (parsed.protocol === 'http:' ? '80' : '443');
    const authorityHost = host.includes(':') ? `[${host}]` : host;
    return `${authorityHost}:${port}`;
  } catch {
    return undefined;
  }
}

export function projectSandboxRuntimeModelGatewayEnv(
  env: Record<string, string> | undefined,
): SandboxRuntimeModelGatewayProjection {
  if (!env) {
    return {
      modelCredentialEnv: env,
      allowedNetworkHosts: [],
      privateNetworkHostMappings: [],
    };
  }
  const baseUrlEnvKeys = new Set(
    listExecutableModelProviders().map(
      (provider) => provider.gateway.sdkProjection.baseUrlEnv,
    ),
  );
  let projected: Record<string, string> | undefined;
  const allowedNetworkHosts = new Set<string>();
  const privateNetworkHostMappings = new Map<string, string>();
  for (const key of baseUrlEnvKeys) {
    const target = loopbackGatewayTargetFromUrl(env[key]);
    if (!target) continue;
    projected ??= { ...env };
    const url = new URL(env[key]!);
    url.hostname = SANDBOX_RUNTIME_MODEL_GATEWAY_HOST;
    projected[key] = url.toString();
    const aliasAuthority = `${SANDBOX_RUNTIME_MODEL_GATEWAY_HOST}:${target.port}`;
    allowedNetworkHosts.add(aliasAuthority);
    privateNetworkHostMappings.set(aliasAuthority, target.connectHost);
  }
  return {
    modelCredentialEnv: projected ?? env,
    allowedNetworkHosts: [...allowedNetworkHosts].sort(),
    privateNetworkHostMappings: [...privateNetworkHostMappings]
      .map(([authority, connectHost]) => ({ authority, connectHost }))
      .sort((a, b) => a.authority.localeCompare(b.authority)),
  };
}

function loopbackGatewayTargetFromUrl(
  value: string | undefined,
): { port: string; connectHost: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      return undefined;
    }
    return {
      port: parsed.port || (parsed.protocol === 'http:' ? '80' : '443'),
      connectHost: host,
    };
  } catch {
    return undefined;
  }
}

function isPreparedExecutionEnvKeyAllowed(key: string): boolean {
  if (PREPARED_EXECUTION_ENV_DENYLIST.has(key)) return false;
  if (key.startsWith('GANTRY_')) {
    return PREPARED_EXECUTION_GANTRY_ENV_ALLOWLIST.has(key);
  }
  if (PREPARED_EXECUTION_SECRET_ENV_PATTERN.test(key)) return false;
  return PREPARED_EXECUTION_ENV_SUFFIX_ALLOWLIST.some((suffix) =>
    key.endsWith(suffix),
  );
}

function expandCredentialPathTemplate(
  value: string,
  source: NodeJS.ProcessEnv,
): string | null {
  let missing = false;
  const expanded = value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
      const envValue = source[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
      const envValue = source[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    })
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, key: string) => {
      const envValue = source[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    });
  return missing ? null : expanded;
}

function mcpServerNameFromRuntimeAccess(
  access: Extract<CapabilityRuntimeAccess, { sourceType: 'mcp_server' }>,
): string | undefined {
  if (access.reviewedServerId && access.reviewedServerId !== 'unknown') {
    return access.reviewedServerId;
  }
  for (const toolName of access.allowedTools) {
    const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function pushAttribution(
  attribution: EgressNetworkAttribution[],
  host: string,
  access: CapabilityRuntimeAccess,
): void {
  const trimmed = host.trim();
  if (!trimmed) return;
  attribution.push({
    host: trimmed,
    capabilityId: access.selectedCapabilityId,
    capabilityLabel: access.auditLabel,
  });
}
