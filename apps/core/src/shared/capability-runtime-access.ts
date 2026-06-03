export type CapabilityRuntimeAccessSourceType =
  | 'local_cli'
  | 'skill_action'
  | 'mcp_server'
  | 'builtin_tool'
  | 'configured_adapter';

export interface CapabilityRuntimeAccessBase {
  selectedCapabilityId: string;
  sourceType: CapabilityRuntimeAccessSourceType;
  auditLabel: string;
}

export interface CommandBoundNetworkBinding {
  commandRules: string[];
  hosts: string[];
}

export interface LocalCliCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'local_cli';
  commandRules: string[];
  credentialDirs: string[];
  networkBindings: CommandBoundNetworkBinding[];
}

export interface SkillActionCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'skill_action';
  skillId: string;
  selectedAction: string;
  declaredEnvRefs: string[];
  commandRules: string[];
  networkBindings: CommandBoundNetworkBinding[];
}

export interface McpServerCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'mcp_server';
  reviewedServerId: string;
  allowedTools: string[];
  credentialRefs: string[];
  networkHosts: string[];
}

export interface BuiltinToolCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'builtin_tool';
  runtimeToolRules: string[];
}

export interface ConfiguredAdapterCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
  sourceType: 'configured_adapter';
  adapterRef: string;
}

export type CapabilityRuntimeAccess =
  | LocalCliCapabilityRuntimeAccess
  | SkillActionCapabilityRuntimeAccess
  | McpServerCapabilityRuntimeAccess
  | BuiltinToolCapabilityRuntimeAccess
  | ConfiguredAdapterCapabilityRuntimeAccess;

const EXACT_EXTERNAL_MCP_TOOL_RE = /^mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_.-]+$/;

export function reviewedExternalMcpToolNamesFromRuntimeAccess(
  runtimeAccess: readonly CapabilityRuntimeAccess[] | undefined,
  options: { serverNames?: readonly string[] } = {},
): string[] {
  const serverNames = options.serverNames
    ? new Set(options.serverNames.map((name) => name.trim()).filter(Boolean))
    : undefined;
  const out = new Set<string>();
  for (const access of runtimeAccess ?? []) {
    if (access.sourceType !== 'mcp_server') continue;
    for (const tool of access.allowedTools) {
      const trimmed = tool.trim();
      const match = EXACT_EXTERNAL_MCP_TOOL_RE.exec(trimmed);
      if (!match?.[1]) continue;
      if (trimmed.startsWith('mcp__gantry__')) continue;
      if (serverNames && !serverNames.has(match[1])) continue;
      out.add(trimmed);
    }
  }
  return [...out];
}
