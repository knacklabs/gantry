import { describe, expect, it } from 'vitest';

import {
  BUILTIN_AGENT_CAPABILITY_PROVIDERS,
  composeAgentCapabilities,
  type AgentCapabilityProvider,
} from '@agent-runner-src/agent-capabilities.js';

const SAFE_DEFAULT_ALLOWED_TOOLS = [
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

const DANGEROUS_DEFAULT_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Config',
  'mcp__myclaw__*',
] as const;

describe('agent capability composition', () => {
  it('uses exact safe defaults and myclaw MCP server wiring', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      groupFolder: 'telegram_team',
      threadId: 'topic-1',
      isMain: false,
      ipcDir: '/tmp/ipc/team',
      ipcAuthToken: 'token',
      ipcResponseVerifyKey: 'verify-key',
    });

    expect(profile.allowedTools).toEqual(SAFE_DEFAULT_ALLOWED_TOOLS);
    for (const tool of DANGEROUS_DEFAULT_TOOLS) {
      expect(profile.allowedTools).not.toContain(tool);
    }
    expect(profile.permissionMode).toBe('default');
    expect(profile.alwaysAllowedTools).toEqual([
      'EnterWorktree',
      'ExitWorktree',
    ]);
    expect(profile.mcpServers.myclaw).toEqual({
      command: 'node',
      args: ['/tmp/ipc-mcp-stdio.js'],
      env: {
        MYCLAW_CHAT_JID: 'tg:team',
        MYCLAW_GROUP_FOLDER: 'telegram_team',
        MYCLAW_THREAD_ID: 'topic-1',
        MYCLAW_IS_MAIN: '0',
        MYCLAW_IPC_DIR: '/tmp/ipc/team',
        MYCLAW_IPC_AUTH_TOKEN: 'token',
        MYCLAW_IPC_RESPONSE_VERIFY_KEY: 'verify-key',
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
      },
    });
  });

  it('supports provider extension without replacing built-ins', () => {
    const extraProvider: AgentCapabilityProvider = {
      id: 'extra',
      provide: () => ({
        allowedTools: ['CustomTool'],
        alwaysAllowedTools: ['CustomTool'],
      }),
    };
    const profile = composeAgentCapabilities(
      {
        mcpServerPath: '/tmp/ipc-mcp-stdio.js',
        chatJid: 'tg:team',
        groupFolder: 'telegram_team',
        isMain: true,
      },
      [...BUILTIN_AGENT_CAPABILITY_PROVIDERS, extraProvider],
    );
    expect(profile.allowedTools).toContain('CustomTool');
    expect(profile.allowedTools).toContain('mcp__myclaw__send_message');
    expect(profile.allowedTools).not.toContain('mcp__myclaw__*');
    expect(profile.alwaysAllowedTools).toContain('CustomTool');
  });

  it('does not expose approved third-party MCP servers as direct SDK tools', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      groupFolder: 'telegram_team',
      isMain: true,
      externalMcpServers: {
        github: {
          type: 'http',
          url: 'https://mcp.example.test/github',
          headers: { Authorization: 'broker-safe-token' },
        },
      },
      externalMcpAllowedTools: ['mcp__github__search_repositories'],
    });

    expect(profile.mcpServers.myclaw).toMatchObject({
      command: 'node',
    });
    expect(profile.mcpServers.github).toBeUndefined();
    expect(profile.allowedTools).toEqual([...SAFE_DEFAULT_ALLOWED_TOOLS]);
    expect(profile.allowedTools).not.toContain(
      'mcp__github__search_repositories',
    );
  });

  it('treats runtime-projected MCP servers as configured MCP input', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      groupFolder: 'telegram_team',
      isMain: true,
      externalMcpServers: {
        agent_browser: {
          type: 'stdio',
          command: '/tmp/playwright-mcp',
          args: ['--cdp-endpoint', 'http://127.0.0.1:4567'],
        },
      },
      externalMcpAllowedTools: ['mcp__agent_browser__*'],
    });

    expect(profile.mcpServers.agent_browser).toEqual({
      type: 'stdio',
      command: '/tmp/playwright-mcp',
      args: ['--cdp-endpoint', 'http://127.0.0.1:4567'],
    });
    expect(profile.allowedTools).not.toContain('mcp__myclaw__*');
    expect(profile.allowedTools).toContain('mcp__agent_browser__*');
  });
});
