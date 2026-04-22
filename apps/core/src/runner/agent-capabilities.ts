export interface AgentCapabilityContext {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  threadId?: string;
  isMain: boolean;
  ipcDir?: string;
  ipcAuthToken?: string;
}

export interface AgentCapabilityProfile {
  allowedTools: readonly string[];
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  >;
  permissionMode: 'default' | 'bypassPermissions';
  alwaysAllowedTools: readonly string[];
}

export interface AgentCapabilityProvider {
  id: string;
  provide: (ctx: AgentCapabilityContext) => Partial<AgentCapabilityProfile>;
}

const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'Config',
  'EnterWorktree',
  'ExitWorktree',
  'mcp__myclaw__*',
] as const;

const ALWAYS_ALLOWED_TOOLS = [
  'Config',
  'EnterWorktree',
  'ExitWorktree',
] as const;

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
  provide: (ctx) => ({
    mcpServers: {
      myclaw: {
        command: 'node',
        args: [ctx.mcpServerPath],
        env: {
          MYCLAW_CHAT_JID: ctx.chatJid,
          MYCLAW_GROUP_FOLDER: ctx.groupFolder,
          MYCLAW_THREAD_ID: ctx.threadId || '',
          MYCLAW_IS_MAIN: ctx.isMain ? '1' : '0',
          ...(ctx.ipcDir ? { MYCLAW_IPC_DIR: ctx.ipcDir } : {}),
          ...(ctx.ipcAuthToken
            ? { MYCLAW_IPC_AUTH_TOKEN: ctx.ipcAuthToken }
            : {}),
        },
      },
    },
  }),
};

export const BUILTIN_AGENT_CAPABILITY_PROVIDERS: readonly AgentCapabilityProvider[] =
  [sdkToolsProvider, permissionProvider, myclawMcpProvider];

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
