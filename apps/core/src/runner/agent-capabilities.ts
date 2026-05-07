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
} from './myclaw-mcp-tool-surface.js';

export interface AgentCapabilityContext {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  persona?: AgentPersona;
  browserProfileName?: string;
  isMain: boolean;
  configuredAllowedTools?: readonly string[];
  ipcDir?: string;
  ipcAuthToken?: string;
  browserIpcAuthToken?: string;
  memoryIpcAuthToken?: string;
  ipcResponseVerifyKey?: string;
  externalMcpServers?: Record<string, McpServerConfig>;
  externalMcpAllowedTools?: readonly string[];
  externalMcpAlwaysAllowedTools?: readonly string[];
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
  permissionMode: 'default' | 'bypassPermissions';
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

const CONFIGURABLE_NATIVE_SDK_TOOL_NAMES = new Set<string>([
  ...SAFE_NATIVE_SDK_TOOLS,
  ...DEVELOPER_NATIVE_SDK_TOOLS,
  'Bash',
  'Edit',
  'Write',
  'LS',
  'MultiEdit',
  'NotebookEdit',
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

const DIRECT_RUNTIME_MCP_SERVER_NAMES = new Set(['agent_browser']);
const NON_DEVELOPER_BLOCKED_TOOL_NAMES = new Set([
  'Bash',
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

function sdkToolName(toolRule: string): string {
  const paren = toolRule.indexOf('(');
  return (paren === -1 ? toolRule : toolRule.slice(0, paren)).trim();
}

function configuredToolAllowedForPersona(
  toolRule: string,
  persona: AgentPersona,
): boolean {
  if (isMyClawMcpWildcardRule(toolRule)) return false;
  const myclawMcpToolName = myclawMcpToolNameFromFullName(toolRule);
  if (myclawMcpToolName) return true;
  const toolName = sdkToolName(toolRule);
  if (!CONFIGURABLE_NATIVE_SDK_TOOL_NAMES.has(toolName)) return false;
  if (persona === 'developer') return true;
  return !NON_DEVELOPER_BLOCKED_TOOL_NAMES.has(toolName);
}

function configuredToolAvailableSdkName(toolRule: string): string | null {
  if (myclawMcpToolNameFromFullName(toolRule)) return null;
  const toolName = sdkToolName(toolRule);
  return CONFIGURABLE_NATIVE_SDK_TOOL_NAMES.has(toolName) ? toolName : null;
}

const sdkToolsProvider: AgentCapabilityProvider = {
  id: 'sdk-tools',
  provide: (ctx) => {
    const persona = resolveAgentPersona(ctx.persona);
    const personaSdkTools =
      persona === 'developer'
        ? [...DEVELOPER_NATIVE_SDK_TOOLS, ...SAFE_NATIVE_SDK_TOOLS]
        : SAFE_NATIVE_SDK_TOOLS;
    return {
      allowedTools:
        persona === 'developer'
          ? [...DEVELOPER_NATIVE_SDK_TOOLS, ...DEFAULT_ALLOWED_TOOLS]
          : DEFAULT_ALLOWED_TOOLS,
      availableTools: personaSdkTools,
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
      MYCLAW_CHAT_JID: ctx.chatJid,
      MYCLAW_GROUP_FOLDER: ctx.groupFolder,
      MYCLAW_THREAD_ID: ctx.threadId || '',
      MYCLAW_MEMORY_USER_ID: ctx.memoryUserId || '',
      MYCLAW_MEMORY_DEFAULT_SCOPE: ctx.memoryDefaultScope || 'group',
      MYCLAW_BROWSER_PROFILE_NAME: ctx.browserProfileName || '',
      MYCLAW_ADMIN_MCP_TOOLS_JSON: JSON.stringify(
        selectedAdminMcpToolNames(ctx.configuredAllowedTools ?? []),
      ),
      MYCLAW_MCP_TOOL_NAMES_JSON: JSON.stringify(
        selectedMyClawMcpToolNames(ctx.configuredAllowedTools ?? []),
      ),
      ...(ctx.ipcDir ? { MYCLAW_IPC_DIR: ctx.ipcDir } : {}),
      ...(ctx.ipcAuthToken ? { MYCLAW_IPC_AUTH_TOKEN: ctx.ipcAuthToken } : {}),
      ...(ctx.browserIpcAuthToken
        ? { MYCLAW_BROWSER_IPC_AUTH_TOKEN: ctx.browserIpcAuthToken }
        : {}),
      ...(ctx.memoryIpcAuthToken
        ? { MYCLAW_MEMORY_IPC_AUTH_TOKEN: ctx.memoryIpcAuthToken }
        : {}),
      ...(ctx.ipcResponseVerifyKey
        ? { MYCLAW_IPC_RESPONSE_VERIFY_KEY: ctx.ipcResponseVerifyKey }
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

const configuredMcpProvider: AgentCapabilityProvider = {
  id: 'configured-mcp',
  provide: (ctx) => {
    const mcpServers = Object.fromEntries(
      Object.entries(ctx.externalMcpServers ?? {}).filter(([name]) =>
        DIRECT_RUNTIME_MCP_SERVER_NAMES.has(name),
      ),
    );
    const allowedServerPrefixes = Object.keys(mcpServers).map(
      (name) => `mcp__${name}__`,
    );
    const isDirectRuntimeTool = (tool: string) =>
      allowedServerPrefixes.some((prefix) => tool.startsWith(prefix));
    return {
      allowedTools: (ctx.externalMcpAllowedTools ?? []).filter(
        isDirectRuntimeTool,
      ),
      alwaysAllowedTools: (ctx.externalMcpAlwaysAllowedTools ?? []).filter(
        isDirectRuntimeTool,
      ),
      mcpServers,
    };
  },
};

const configuredToolProvider: AgentCapabilityProvider = {
  id: 'configured-tools',
  provide: (ctx) => {
    const persona = resolveAgentPersona(ctx.persona);
    const allowedTools = (ctx.configuredAllowedTools ?? []).filter((toolRule) =>
      configuredToolAllowedForPersona(toolRule, persona),
    );
    const availableTools = allowedTools
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
