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
  attachedSkillSourceIds?: readonly string[];
  selectedSkillDisplays?: readonly string[];
  attachedMcpSourceIds?: readonly string[];
  semanticCapabilities?: readonly SemanticCapabilityDefinition[];
  ipcDir?: string;
  ipcAuthToken?: string;
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

const DEFAULT_ALLOWED_TOOLS = [
  ...SAFE_NATIVE_SDK_TOOLS,
  ...GANTRY_MCP_ALLOWED_TOOLS,
] as const;

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
    const baseAvailableTools = ctx.isScheduledJob
      ? [
          ...(persona === 'developer' ? DEVELOPER_NATIVE_SDK_TOOLS : []),
          ...SAFE_NATIVE_SDK_TOOLS,
        ]
      : AVAILABLE_NATIVE_SDK_TOOLS;
    return {
      allowedTools:
        persona === 'developer'
          ? [...DEVELOPER_NATIVE_SDK_TOOLS, ...DEFAULT_ALLOWED_TOOLS]
          : DEFAULT_ALLOWED_TOOLS,
      availableTools: baseAvailableTools,
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
      GANTRY_CHAT_JID: ctx.chatJid,
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
        }),
      ),
      GANTRY_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(
        selectedMemoryIpcActions(ctx.configuredAllowedTools ?? [], {
          memoryReviewerIsControlApprover: ctx.memoryReviewerIsControlApprover,
        }),
      ),
      ...(ctx.ipcDir ? { GANTRY_IPC_DIR: ctx.ipcDir } : {}),
      ...(ctx.ipcAuthToken ? { GANTRY_IPC_AUTH_TOKEN: ctx.ipcAuthToken } : {}),
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
