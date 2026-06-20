import { applyAgentEgressNoProxyEnv } from '../../../shared/no-proxy.js';
import {
  resolveAgentPersona,
  type AgentPersona,
} from '../../../shared/agent-persona.js';
import {
  adminMcpToolNameFromFullName,
  isGantryMcpWildcardRule,
} from '../../../shared/admin-mcp-tools.js';
import {
  DEFAULT_GANTRY_MCP_TOOL_NAMES,
  gantryMcpFullToolName,
  gantryMcpToolNameFromFullName,
  selectedGantryMcpFullToolNames,
  selectedGantryMcpToolNames,
  selectedMemoryIpcActions,
} from '../../../runner/gantry-mcp-tool-surface.js';
import {
  isBrowserActionMcpToolRule,
  isCanonicalBrowserCapabilityRule,
  isHostPrivateBrowserMcpServerName,
  parseReadableScopedToolRule,
  RUN_COMMAND_TOOL_NAME,
  sdkToolsForGantryFacadeTool,
} from '../../../shared/agent-tool-references.js';
import {
  AVAILABLE_NATIVE_SDK_TOOLS,
  DEVELOPER_NATIVE_SDK_TOOLS,
  SAFE_NATIVE_SDK_TOOLS,
  UNSUPPORTED_CLAUDE_CODE_BUILTIN_TOOLS,
} from './native-sdk-tools.js';
import type { SemanticCapabilityDefinition } from '../../../shared/semantic-capabilities.js';

export interface AgentCapabilityContext {
  mcpServerPath: string;
  appId?: string;
  agentId?: string;
  chatJid: string;
  groupFolder: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  memoryReviewerIsControlApprover?: boolean;
  persona?: AgentPersona;
  browserProfileName?: string;
  configuredAllowedTools?: readonly string[];
  /** Per-agent gantry MCP tool keep-list (settings `tool_surface.gantry_mcp`). */
  gantryMcpToolSurface?: readonly string[];
  /** Per-agent native SDK tool keep-list (settings `tool_surface.native`). */
  nativeToolSurface?: readonly string[];
  attachedSkillSourceIds?: readonly string[];
  selectedSkillDisplays?: readonly string[];
  attachedMcpSourceIds?: readonly string[];
  semanticCapabilities?: readonly SemanticCapabilityDefinition[];
  ipcDir?: string;
  ipcAuthToken?: string;
  ipcSocketPath?: string;
  boundIdentityFile?: string;
  browserIpcAuthToken?: string;
  memoryIpcAuthToken?: string;
  ipcResponseVerifyKey?: string;
  ipcResponseKeyId?: string;
  externalMcpServers?: Record<string, McpServerConfig>;
  externalMcpAllowedTools?: readonly string[];
  externalMcpAlwaysAllowedTools?: readonly string[];
  isScheduledJob?: boolean;
}

export type McpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /** SDK: include this server's tool schemas in the prompt, never deferred behind ToolSearch. */
      alwaysLoad?: boolean;
    }
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    };

export interface AgentCapabilityProfile {
  allowedTools: readonly string[];
  availableTools: readonly string[];
  disallowedTools: readonly string[];
  mcpServers: Record<string, McpServerConfig>;
  permissionMode: 'default';
  alwaysAllowedTools: readonly string[];
}

export interface AgentCapabilityProvider {
  id: string;
  provide: (ctx: AgentCapabilityContext) => Partial<AgentCapabilityProfile>;
}

const CONFIGURABLE_NATIVE_SDK_TOOL_NAMES = new Set<string>([
  ...AVAILABLE_NATIVE_SDK_TOOLS,
]);

const GANTRY_MCP_ALLOWED_TOOLS = DEFAULT_GANTRY_MCP_TOOL_NAMES.map(
  gantryMcpFullToolName,
);

// The default allow-list, with each surface narrowed to its per-agent keep-list
// when configured: the gantry MCP portion to `tool_surface.gantry_mcp`, the
// native (safe) portion to `tool_surface.native`.
function defaultAllowedToolsForSurface(
  gantryKeepList: readonly string[] | undefined,
  nativeKeep: ReadonlySet<string> | null,
): readonly string[] {
  const safe = nativeKeep
    ? SAFE_NATIVE_SDK_TOOLS.filter((name) => nativeKeep.has(name))
    : SAFE_NATIVE_SDK_TOOLS;
  if (!gantryKeepList) return [...safe, ...GANTRY_MCP_ALLOWED_TOOLS];
  const keep = new Set(gantryKeepList);
  return [
    ...safe,
    ...DEFAULT_GANTRY_MCP_TOOL_NAMES.filter((name) => keep.has(name)).map(
      gantryMcpFullToolName,
    ),
  ];
}

function configuredToolAllowedSdkNames(toolRule: string): string[] {
  const trimmed = toolRule.trim();
  if (!trimmed || trimmed === 'Bash') return [];
  if (hasScopeSyntax(trimmed)) return [];
  if (parseReadableScopedToolRule(trimmed)) return [];
  if (isGantryMcpWildcardRule(toolRule)) return [];
  const gantryMcpToolName = gantryMcpToolNameFromFullName(toolRule);
  if (gantryMcpToolName?.startsWith('browser')) return [];
  if (gantryMcpToolName) return [trimmed];
  return sdkToolsForGantryFacadeTool(trimmed).filter((toolName) =>
    CONFIGURABLE_NATIVE_SDK_TOOL_NAMES.has(toolName),
  );
}

function configuredToolAvailableSdkNames(toolRule: string): string[] {
  const readableScopedRule = parseReadableScopedToolRule(toolRule);
  if (readableScopedRule) {
    return readableScopedRule.toolName === RUN_COMMAND_TOOL_NAME
      ? ['Bash']
      : [];
  }
  const trimmed = toolRule.trim();
  if (trimmed === 'Bash') return [];
  if (hasScopeSyntax(trimmed)) return [];
  if (gantryMcpToolNameFromFullName(trimmed)) return [];
  return sdkToolsForGantryFacadeTool(trimmed).filter((toolName) =>
    CONFIGURABLE_NATIVE_SDK_TOOL_NAMES.has(toolName),
  );
}

function hasScopeSyntax(toolRule: string): boolean {
  return toolRule.includes('(') || toolRule.includes(')');
}

const sdkToolsProvider: AgentCapabilityProvider = {
  id: 'sdk-tools',
  provide: (ctx) => {
    const persona = resolveAgentPersona(ctx.persona);
    // Per-agent native keep-list (settings `tool_surface.native`): drop the
    // native tool SCHEMAS this agent never uses (a sales persona keeps only
    // Skill/ToolSearch), shrinking the prompt prefix. Purely subtractive.
    const nativeKeep = ctx.nativeToolSurface
      ? new Set(ctx.nativeToolSurface)
      : null;
    const selectedSkillsExist = (ctx.attachedSkillSourceIds?.length ?? 0) > 0;
    const availableNativeKeep =
      nativeKeep && selectedSkillsExist
        ? new Set([...nativeKeep, 'Skill'])
        : nativeKeep;
    const filterNative = <T extends string>(
      tools: readonly T[],
      keep: ReadonlySet<string> | null = nativeKeep,
    ): T[] => (keep ? tools.filter((tool) => keep.has(tool)) : [...tools]);
    const baseAvailableTools = ctx.isScheduledJob
      ? [
          ...(persona === 'developer' ? DEVELOPER_NATIVE_SDK_TOOLS : []),
          ...SAFE_NATIVE_SDK_TOOLS,
        ]
      : AVAILABLE_NATIVE_SDK_TOOLS;
    const defaultAllowedTools = defaultAllowedToolsForSurface(
      ctx.gantryMcpToolSurface,
      nativeKeep,
    );
    return {
      allowedTools:
        persona === 'developer'
          ? [
              ...filterNative(DEVELOPER_NATIVE_SDK_TOOLS),
              ...defaultAllowedTools,
            ]
          : defaultAllowedTools,
      availableTools: filterNative(baseAvailableTools, availableNativeKeep),
      disallowedTools: UNSUPPORTED_CLAUDE_CODE_BUILTIN_TOOLS,
    };
  },
};

const permissionProvider: AgentCapabilityProvider = {
  id: 'permissions',
  provide: () => ({
    permissionMode: 'default',
    alwaysAllowedTools: [],
  }),
};

const gantryMcpProvider: AgentCapabilityProvider = {
  id: 'gantry-mcp',
  provide: (ctx) => {
    const env: Record<string, string> = {
      ...(ctx.appId ? { GANTRY_APP_ID: ctx.appId } : {}),
      ...(ctx.agentId ? { GANTRY_AGENT_ID: ctx.agentId } : {}),
      // Propagate this run's handle into the gantry MCP server subprocess so its
      // outbound MCP-call IPC writes carry the handle the reply latency trace
      // keys on. The runner process owns this ambient value, same as the other
      // GANTRY_* runtime env the runner reads.
      ...(process.env.GANTRY_AGENT_RUN_HANDLE
        ? { GANTRY_AGENT_RUN_HANDLE: process.env.GANTRY_AGENT_RUN_HANDLE }
        : {}),
      GANTRY_CHAT_JID: ctx.chatJid,
      ...(ctx.boundIdentityFile
        ? { GANTRY_BOUND_IDENTITY_FILE: ctx.boundIdentityFile }
        : {}),
      GANTRY_GROUP_FOLDER: ctx.groupFolder,
      GANTRY_THREAD_ID: ctx.threadId || '',
      GANTRY_MEMORY_USER_ID: ctx.memoryUserId || '',
      GANTRY_MEMORY_DEFAULT_SCOPE: ctx.memoryDefaultScope || 'group',
      GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER:
        ctx.memoryReviewerIsControlApprover ? '1' : '',
      GANTRY_BROWSER_PROFILE_NAME: ctx.browserProfileName || '',
      GANTRY_ADMIN_MCP_TOOLS_JSON: JSON.stringify(
        selectedAdminMcpToolNames(ctx.configuredAllowedTools ?? []),
      ),
      GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify(
        ctx.configuredAllowedTools ?? [],
      ),
      GANTRY_SELECTED_SKILLS_JSON: JSON.stringify(
        ctx.attachedSkillSourceIds ?? [],
      ),
      GANTRY_SELECTED_SKILL_DISPLAYS_JSON: JSON.stringify(
        ctx.selectedSkillDisplays ?? ctx.attachedSkillSourceIds ?? [],
      ),
      GANTRY_SELECTED_MCP_SERVERS_JSON: JSON.stringify(
        ctx.attachedMcpSourceIds ?? [],
      ),
      GANTRY_SEMANTIC_CAPABILITIES_JSON: JSON.stringify(
        ctx.semanticCapabilities ?? [],
      ),
      GANTRY_MCP_TOOL_NAMES_JSON: JSON.stringify(
        selectedGantryMcpToolNames(ctx.configuredAllowedTools ?? [], {
          memoryReviewerIsControlApprover: ctx.memoryReviewerIsControlApprover,
          toolSurfaceKeepList: ctx.gantryMcpToolSurface ?? null,
        }),
      ),
      // The runner-side parser re-seeds the default surface for stale-projection
      // safety, so an explicit restriction travels as its own projection.
      ...(ctx.gantryMcpToolSurface
        ? {
            GANTRY_MCP_TOOL_SURFACE_JSON: JSON.stringify(
              ctx.gantryMcpToolSurface,
            ),
          }
        : {}),
      GANTRY_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(
        selectedMemoryIpcActions(ctx.configuredAllowedTools ?? [], {
          memoryReviewerIsControlApprover: ctx.memoryReviewerIsControlApprover,
        }),
      ),
      ...(ctx.ipcDir ? { GANTRY_IPC_DIR: ctx.ipcDir } : {}),
      ...(ctx.ipcAuthToken ? { GANTRY_IPC_AUTH_TOKEN: ctx.ipcAuthToken } : {}),
      ...(ctx.ipcSocketPath
        ? { GANTRY_IPC_SOCKET_PATH: ctx.ipcSocketPath }
        : {}),
      ...(ctx.browserIpcAuthToken &&
      (ctx.configuredAllowedTools ?? []).some(isCanonicalBrowserCapabilityRule)
        ? { GANTRY_BROWSER_IPC_AUTH_TOKEN: ctx.browserIpcAuthToken }
        : {}),
      ...(ctx.memoryIpcAuthToken
        ? { GANTRY_MEMORY_IPC_AUTH_TOKEN: ctx.memoryIpcAuthToken }
        : {}),
      ...(ctx.ipcResponseVerifyKey
        ? { GANTRY_IPC_RESPONSE_VERIFY_KEY: ctx.ipcResponseVerifyKey }
        : {}),
      ...(ctx.ipcResponseKeyId
        ? { GANTRY_IPC_RESPONSE_KEY_ID: ctx.ipcResponseKeyId }
        : {}),
    };
    applyAgentEgressNoProxyEnv(env);
    return {
      mcpServers: {
        gantry: {
          command: 'node',
          args: [ctx.mcpServerPath],
          env,
          // A configured keep-list means the surface is deliberately small, so
          // its few schemas go straight into the prompt instead of behind a
          // ToolSearch discovery round (the SDK defers MCP tools by default).
          ...(ctx.gantryMcpToolSurface ? { alwaysLoad: true } : {}),
        },
      },
    };
  },
};

function selectedAdminMcpToolNames(
  configuredTools: readonly string[],
): string[] {
  const names = new Set<string>();
  for (const configuredTool of configuredTools) {
    const name = adminMcpToolNameFromFullName(configuredTool.trim());
    if (name) names.add(name);
  }
  return [...names].sort();
}

function isPublicExternalMcpServerName(name: string): boolean {
  return !isHostPrivateBrowserMcpServerName(name);
}

function isPublicExternalMcpServerConfig(
  name: string,
  config: McpServerConfig,
): boolean {
  if (!isPublicExternalMcpServerName(name)) return false;
  return config.type !== 'http' && config.type !== 'sse';
}

const PUBLIC_EXTERNAL_MCP_TOOL_RULE_RE =
  /^mcp__[A-Za-z0-9_-]+__(?:[A-Za-z0-9_-]+|\*)$/;

export function isPublicExternalMcpToolRule(toolRule: string): boolean {
  const value = toolRule.trim();
  return (
    PUBLIC_EXTERNAL_MCP_TOOL_RULE_RE.test(value) &&
    !value.startsWith('mcp__gantry__') &&
    !isBrowserActionMcpToolRule(value)
  );
}

function externalMcpToolServerName(toolRule: string): string | null {
  const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolRule.trim());
  return match?.[1] ?? null;
}

const configuredMcpProvider: AgentCapabilityProvider = {
  id: 'configured-mcp',
  provide: (ctx) => {
    const mcpServers = Object.fromEntries(
      Object.entries(ctx.externalMcpServers ?? {}).filter(([name, config]) =>
        isPublicExternalMcpServerConfig(name, config),
      ),
    );
    const exposedServerNames = new Set(Object.keys(mcpServers));
    const exposedToolRule = (toolRule: string) => {
      const serverName = externalMcpToolServerName(toolRule);
      return (
        isPublicExternalMcpToolRule(toolRule) &&
        serverName !== null &&
        exposedServerNames.has(serverName)
      );
    };
    return {
      allowedTools: (ctx.externalMcpAllowedTools ?? []).filter(exposedToolRule),
      alwaysAllowedTools: (ctx.externalMcpAlwaysAllowedTools ?? []).filter(
        exposedToolRule,
      ),
      mcpServers,
    };
  },
};

const configuredToolProvider: AgentCapabilityProvider = {
  id: 'configured-tools',
  provide: (ctx) => {
    const allowedTools = (ctx.configuredAllowedTools ?? []).flatMap(
      configuredToolAllowedSdkNames,
    );
    const availableTools = (ctx.configuredAllowedTools ?? [])
      .flatMap(configuredToolAvailableSdkNames)
      .filter((toolName) => toolName.length > 0);
    return {
      allowedTools: mergeUnique(
        allowedTools,
        selectedGantryMcpFullToolNames(ctx.configuredAllowedTools ?? [], {
          memoryReviewerIsControlApprover: ctx.memoryReviewerIsControlApprover,
          toolSurfaceKeepList: ctx.gantryMcpToolSurface ?? null,
        }),
      ),
      availableTools,
    };
  },
};

export const BUILTIN_AGENT_CAPABILITY_PROVIDERS: readonly AgentCapabilityProvider[] =
  [
    sdkToolsProvider,
    permissionProvider,
    gantryMcpProvider,
    configuredToolProvider,
    configuredMcpProvider,
  ];

function mergeUnique(
  base: readonly string[],
  next: readonly string[],
): string[] {
  const out = new Set<string>(base);
  for (const item of next) out.add(item);
  return [...out];
}

export function composeAgentCapabilities(
  ctx: AgentCapabilityContext,
  providers: readonly AgentCapabilityProvider[] = BUILTIN_AGENT_CAPABILITY_PROVIDERS,
): AgentCapabilityProfile {
  let allowedTools: readonly string[] = [];
  let availableTools: readonly string[] = [];
  let disallowedTools: readonly string[] = [];
  let mcpServers: AgentCapabilityProfile['mcpServers'] = {};
  let permissionMode: AgentCapabilityProfile['permissionMode'] = 'default';
  let alwaysAllowedTools: readonly string[] = [];

  for (const provider of providers) {
    const partial = provider.provide(ctx);
    if (partial.allowedTools) {
      allowedTools = mergeUnique(allowedTools, partial.allowedTools);
    }
    if (partial.availableTools) {
      availableTools = mergeUnique(availableTools, partial.availableTools);
    }
    if (partial.disallowedTools) {
      disallowedTools = mergeUnique(disallowedTools, partial.disallowedTools);
    }
    if (partial.mcpServers) {
      mcpServers = { ...mcpServers, ...partial.mcpServers };
    }
    if (partial.permissionMode) {
      permissionMode = partial.permissionMode;
    }
    if (partial.alwaysAllowedTools) {
      alwaysAllowedTools = mergeUnique(
        alwaysAllowedTools,
        partial.alwaysAllowedTools,
      );
    }
  }

  return {
    allowedTools,
    availableTools,
    disallowedTools,
    mcpServers,
    permissionMode,
    alwaysAllowedTools,
  };
}
