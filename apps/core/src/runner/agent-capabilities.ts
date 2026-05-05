import { applyAgentEgressNoProxyEnv } from '../shared/no-proxy.js';
import {
  resolveAgentPersona,
  type AgentPersona,
} from '../shared/agent-persona.js';
import {
  adminMcpToolNameFromFullName,
  isMyClawMcpWildcardRule,
} from '../shared/admin-mcp-tools.js';

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
  mcpServers: Record<string, McpServerConfig>;
  permissionMode: 'default' | 'bypassPermissions';
  alwaysAllowedTools: readonly string[];
}

export interface AgentCapabilityProvider {
  id: string;
  provide: (ctx: AgentCapabilityContext) => Partial<AgentCapabilityProfile>;
}

const SAFE_NATIVE_ALLOWED_TOOLS = [
  'Agent',
  'Browser',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
] as const;

const DEVELOPER_NATIVE_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'TaskOutput',
  'TaskStop',
  'EnterWorktree',
  'ExitWorktree',
] as const;

const MYCLAW_MCP_ALLOWED_TOOLS = [
  'mcp__myclaw__send_message',
  'mcp__myclaw__ask_user_question',
  'mcp__myclaw__memory_search',
  'mcp__myclaw__memory_save',
  'mcp__myclaw__procedure_save',
  'mcp__myclaw__browser_launch',
  'mcp__myclaw__browser_status',
  'mcp__myclaw__request_skill_install',
  'mcp__myclaw__request_skill_proposal',
  'mcp__myclaw__request_skill_dependency_install',
  'mcp__myclaw__request_mcp_server',
  'mcp__myclaw__request_permission',
  'mcp__myclaw__capability_status',
  'mcp__myclaw__mcp_list_tools',
  'mcp__myclaw__mcp_call_tool',
] as const;

const DEFAULT_ALLOWED_TOOLS = [
  ...SAFE_NATIVE_ALLOWED_TOOLS,
  ...MYCLAW_MCP_ALLOWED_TOOLS,
] as const;

const ALWAYS_ALLOWED_TOOLS = ['EnterWorktree', 'ExitWorktree'] as const;
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
  'EnterWorktree',
  'ExitWorktree',
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
  if (persona === 'developer') return true;
  return !NON_DEVELOPER_BLOCKED_TOOL_NAMES.has(sdkToolName(toolRule));
}

const sdkToolsProvider: AgentCapabilityProvider = {
  id: 'sdk-tools',
  provide: (ctx) => {
    const persona = resolveAgentPersona(ctx.persona);
    const personaTools =
      persona === 'developer'
        ? [...DEVELOPER_NATIVE_ALLOWED_TOOLS, ...DEFAULT_ALLOWED_TOOLS]
        : DEFAULT_ALLOWED_TOOLS;
    return {
      allowedTools: personaTools,
    };
  },
};

const permissionProvider: AgentCapabilityProvider = {
  id: 'permissions',
  provide: (ctx) => ({
    permissionMode: 'default',
    alwaysAllowedTools:
      resolveAgentPersona(ctx.persona) === 'developer'
        ? ALWAYS_ALLOWED_TOOLS
        : [],
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
    return {
      allowedTools: (ctx.configuredAllowedTools ?? []).filter((toolRule) =>
        configuredToolAllowedForPersona(toolRule, persona),
      ),
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
  let mcpServers: AgentCapabilityProfile['mcpServers'] = {};
  let permissionMode: AgentCapabilityProfile['permissionMode'] = 'default';
  let alwaysAllowedTools: readonly string[] = [];

  for (const provider of providers) {
    const partial = provider.provide(ctx);
    if (partial.allowedTools) {
      allowedTools = mergeUnique(allowedTools, partial.allowedTools);
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
    mcpServers,
    permissionMode,
    alwaysAllowedTools,
  };
}
