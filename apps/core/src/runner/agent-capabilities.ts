import { applyLoopbackNoProxyEnv } from '../shared/no-proxy.js';

export interface AgentCapabilityContext {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  threadId?: string;
  isMain: boolean;
  ipcDir?: string;
  ipcAuthToken?: string;
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
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'ToolSearch',
  'Skill',
  'EnterWorktree',
  'ExitWorktree',
] as const;

const MYCLAW_MCP_ALLOWED_TOOLS = [
  'mcp__myclaw__send_message',
  'mcp__myclaw__ask_user_question',
  'mcp__myclaw__request_skill_install',
  'mcp__myclaw__request_skill_proposal',
  'mcp__myclaw__request_skill_dependency_install',
  'mcp__myclaw__request_mcp_server',
  'mcp__myclaw__request_tool_enable',
  'mcp__myclaw__request_channel_tool_enable',
  'mcp__myclaw__mcp_list_tools',
  'mcp__myclaw__mcp_call_tool',
  'mcp__myclaw__service_restart',
  'mcp__myclaw__register_agent',
] as const;

const DEFAULT_ALLOWED_TOOLS = [
  ...SAFE_NATIVE_ALLOWED_TOOLS,
  ...MYCLAW_MCP_ALLOWED_TOOLS,
] as const;

const ALWAYS_ALLOWED_TOOLS = ['EnterWorktree', 'ExitWorktree'] as const;
const DIRECT_RUNTIME_MCP_SERVER_NAMES = new Set(['agent_browser']);

const sdkToolsProvider: AgentCapabilityProvider = {
  id: 'sdk-tools',
  provide: () => ({
    allowedTools: DEFAULT_ALLOWED_TOOLS,
  }),
};

const permissionProvider: AgentCapabilityProvider = {
  id: 'permissions',
  provide: () => ({
    permissionMode: 'default',
    alwaysAllowedTools: ALWAYS_ALLOWED_TOOLS,
  }),
};

const myclawMcpProvider: AgentCapabilityProvider = {
  id: 'myclaw-mcp',
  provide: (ctx) => {
    const env: Record<string, string> = {
      MYCLAW_CHAT_JID: ctx.chatJid,
      MYCLAW_GROUP_FOLDER: ctx.groupFolder,
      MYCLAW_THREAD_ID: ctx.threadId || '',
      MYCLAW_IS_MAIN: ctx.isMain ? '1' : '0',
      ...(ctx.ipcDir ? { MYCLAW_IPC_DIR: ctx.ipcDir } : {}),
      ...(ctx.ipcAuthToken ? { MYCLAW_IPC_AUTH_TOKEN: ctx.ipcAuthToken } : {}),
      ...(ctx.ipcResponseVerifyKey
        ? { MYCLAW_IPC_RESPONSE_VERIFY_KEY: ctx.ipcResponseVerifyKey }
        : {}),
    };
    applyLoopbackNoProxyEnv(env);
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

export const BUILTIN_AGENT_CAPABILITY_PROVIDERS: readonly AgentCapabilityProvider[] =
  [
    sdkToolsProvider,
    permissionProvider,
    myclawMcpProvider,
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
