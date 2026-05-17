import { applyAgentEgressNoProxyEnv } from '../shared/no-proxy.js';
import {
  resolveAgentPersona,
  type AgentPersona,
} from '../shared/agent-persona.js';
import {
  adminMcpToolNameFromFullName,
  isMyClawMcpWildcardRule,
} from '../shared/admin-mcp-tools.js';
import {
  DEFAULT_MYCLAW_MCP_TOOL_NAMES,
  myclawMcpFullToolName,
  myclawMcpToolNameFromFullName,
  selectedMyClawMcpFullToolNames,
  selectedMyClawMcpToolNames,
  selectedMemoryIpcActions,
} from './myclaw-mcp-tool-surface.js';
import {
  isBrowserActionMcpToolRule,
  isCanonicalBrowserCapabilityRule,
  isHostPrivateBrowserMcpServerName,
  parseReadableScopedToolRule,
} from '../shared/agent-tool-references.js';

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
  selectedSkillIds?: readonly string[];
  selectedMcpServerIds?: readonly string[];
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

const SAFE_NATIVE_SDK_TOOLS = [
  'Agent',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
] as const;

const DEVELOPER_NATIVE_SDK_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const PERMISSION_GATED_NATIVE_SDK_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'LS',
  'MultiEdit',
  'NotebookEdit',
] as const;
const AVAILABLE_NATIVE_SDK_TOOLS = [
  ...DEVELOPER_NATIVE_SDK_TOOLS,
  ...PERMISSION_GATED_NATIVE_SDK_TOOLS,
  ...SAFE_NATIVE_SDK_TOOLS,
] as const;

const CONFIGURABLE_NATIVE_SDK_TOOL_NAMES = new Set<string>([
  ...AVAILABLE_NATIVE_SDK_TOOLS,
]);

export const UNSUPPORTED_CLAUDE_CODE_BUILTIN_TOOLS = [
  'AskUserQuestion',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'ScheduleWakeup',
  'PushNotification',
  'TeamCreate',
  'TeamDelete',
  'TaskOutput',
  'TaskStop',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'TodoWrite',
  'ListMcpResources',
  'ReadMcpResource',
] as const;

const MYCLAW_MCP_ALLOWED_TOOLS = DEFAULT_MYCLAW_MCP_TOOL_NAMES.map(
  myclawMcpFullToolName,
);

const DEFAULT_ALLOWED_TOOLS = [
  ...SAFE_NATIVE_SDK_TOOLS,
  ...MYCLAW_MCP_ALLOWED_TOOLS,
] as const;

function sdkToolName(toolRule: string): string {
  const paren = toolRule.indexOf('(');
  return (paren === -1 ? toolRule : toolRule.slice(0, paren)).trim();
}

function configuredToolAllowedForPersona(toolRule: string): boolean {
  if (toolRule.trim() === 'Bash') return false;
  if (hasScopeSyntax(toolRule)) return false;
  if (parseReadableScopedToolRule(toolRule)) return false;
  if (isMyClawMcpWildcardRule(toolRule)) return false;
  const myclawMcpToolName = myclawMcpToolNameFromFullName(toolRule);
  if (myclawMcpToolName?.startsWith('browser')) return false;
  if (myclawMcpToolName) return true;
  const toolName = sdkToolName(toolRule);
  return CONFIGURABLE_NATIVE_SDK_TOOL_NAMES.has(toolName);
}

function configuredToolAvailableSdkName(toolRule: string): string | null {
  const readableScopedRule = parseReadableScopedToolRule(toolRule);
  if (readableScopedRule) {
    return readableScopedRule.toolName === 'Bash' ? 'Bash' : null;
  }
  if (toolRule.trim() === 'Bash') return null;
  if (hasScopeSyntax(toolRule)) return null;
  if (myclawMcpToolNameFromFullName(toolRule)) return null;
  const toolName = sdkToolName(toolRule);
  return CONFIGURABLE_NATIVE_SDK_TOOL_NAMES.has(toolName) ? toolName : null;
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

const myclawMcpProvider: AgentCapabilityProvider = {
  id: 'myclaw-mcp',
  provide: (ctx) => {
    const env: Record<string, string> = {
      ...(ctx.appId ? { MYCLAW_APP_ID: ctx.appId } : {}),
      ...(ctx.agentId ? { MYCLAW_AGENT_ID: ctx.agentId } : {}),
      MYCLAW_CHAT_JID: ctx.chatJid,
      MYCLAW_GROUP_FOLDER: ctx.groupFolder,
      MYCLAW_THREAD_ID: ctx.threadId || '',
      MYCLAW_MEMORY_USER_ID: ctx.memoryUserId || '',
      MYCLAW_MEMORY_DEFAULT_SCOPE: ctx.memoryDefaultScope || 'group',
      MYCLAW_MEMORY_REVIEWER_IS_CONTROL_APPROVER:
        ctx.memoryReviewerIsControlApprover ? '1' : '',
      MYCLAW_BROWSER_PROFILE_NAME: ctx.browserProfileName || '',
      MYCLAW_ADMIN_MCP_TOOLS_JSON: JSON.stringify(
        selectedAdminMcpToolNames(ctx.configuredAllowedTools ?? []),
      ),
      MYCLAW_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify(
        ctx.configuredAllowedTools ?? [],
      ),
      MYCLAW_SELECTED_SKILLS_JSON: JSON.stringify(ctx.selectedSkillIds ?? []),
      MYCLAW_SELECTED_MCP_SERVERS_JSON: JSON.stringify(
        ctx.selectedMcpServerIds ?? [],
      ),
      MYCLAW_MCP_TOOL_NAMES_JSON: JSON.stringify(
        selectedMyClawMcpToolNames(ctx.configuredAllowedTools ?? []),
      ),
      MYCLAW_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(
        selectedMemoryIpcActions(ctx.configuredAllowedTools ?? []),
      ),
      ...(ctx.ipcDir ? { MYCLAW_IPC_DIR: ctx.ipcDir } : {}),
      ...(ctx.ipcAuthToken ? { MYCLAW_IPC_AUTH_TOKEN: ctx.ipcAuthToken } : {}),
      ...(ctx.browserIpcAuthToken &&
      (ctx.configuredAllowedTools ?? []).some(isCanonicalBrowserCapabilityRule)
        ? { MYCLAW_BROWSER_IPC_AUTH_TOKEN: ctx.browserIpcAuthToken }
        : {}),
      ...(ctx.memoryIpcAuthToken
        ? { MYCLAW_MEMORY_IPC_AUTH_TOKEN: ctx.memoryIpcAuthToken }
        : {}),
      ...(ctx.ipcResponseVerifyKey
        ? { MYCLAW_IPC_RESPONSE_VERIFY_KEY: ctx.ipcResponseVerifyKey }
        : {}),
      ...(ctx.ipcResponseKeyId
        ? { MYCLAW_IPC_RESPONSE_KEY_ID: ctx.ipcResponseKeyId }
        : {}),
    };
    applyAgentEgressNoProxyEnv(env);
    return {
      mcpServers: {
        myclaw: {
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
    !value.startsWith('mcp__myclaw__') &&
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
    const allowedTools = (ctx.configuredAllowedTools ?? []).filter((toolRule) =>
      configuredToolAllowedForPersona(toolRule),
    );
    const availableTools = (ctx.configuredAllowedTools ?? [])
      .map(configuredToolAvailableSdkName)
      .filter((toolName): toolName is string => toolName !== null);
    return {
      allowedTools: mergeUnique(
        allowedTools,
        selectedMyClawMcpFullToolNames(ctx.configuredAllowedTools ?? []),
      ),
      availableTools,
    };
  },
};

export const BUILTIN_AGENT_CAPABILITY_PROVIDERS: readonly AgentCapabilityProvider[] =
  [
    sdkToolsProvider,
    permissionProvider,
    myclawMcpProvider,
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
