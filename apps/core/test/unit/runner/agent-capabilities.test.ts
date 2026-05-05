import { describe, expect, it } from 'vitest';

import {
  BUILTIN_AGENT_CAPABILITY_PROVIDERS,
  composeAgentCapabilities,
  type AgentCapabilityProvider,
} from '@agent-runner-src/agent-capabilities.js';

const SAFE_DEFAULT_ALLOWED_TOOLS = [
  'Agent',
  'Browser',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
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

const DEVELOPER_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'TaskOutput',
  'TaskStop',
  'EnterWorktree',
  'ExitWorktree',
  ...SAFE_DEFAULT_ALLOWED_TOOLS,
] as const;

const CONFIGURED_ADMIN_ALLOWED_TOOLS = [
  ...DEVELOPER_ALLOWED_TOOLS,
  'mcp__myclaw__settings_desired_state',
  'mcp__myclaw__request_settings_update',
  'mcp__myclaw__service_restart',
  'mcp__myclaw__register_agent',
] as const;

const DANGEROUS_DEFAULT_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Config',
  'mcp__myclaw__list_models',
  'mcp__myclaw__*',
] as const;

describe('agent capability composition', () => {
  it('uses exact safe defaults and myclaw MCP server wiring', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      groupFolder: 'telegram_team',
      threadId: 'topic-1',
      memoryUserId: '5759865942',
      browserProfileName: 'c-team-abc123abc123',
      isMain: false,
      ipcDir: '/tmp/ipc/team',
      ipcAuthToken: 'token',
      browserIpcAuthToken: 'browser-token',
      memoryIpcAuthToken: 'memory-token',
      ipcResponseVerifyKey: 'verify-key',
      persona: 'personal_assistant',
    });

    expect(profile.allowedTools).toEqual(SAFE_DEFAULT_ALLOWED_TOOLS);
    for (const tool of DANGEROUS_DEFAULT_TOOLS) {
      expect(profile.allowedTools).not.toContain(tool);
    }
    expect(profile.permissionMode).toBe('default');
    expect(profile.alwaysAllowedTools).toEqual([]);
    expect(profile.mcpServers.myclaw).toEqual({
      command: 'node',
      args: ['/tmp/ipc-mcp-stdio.js'],
      env: {
        MYCLAW_CHAT_JID: 'tg:team',
        MYCLAW_GROUP_FOLDER: 'telegram_team',
        MYCLAW_THREAD_ID: 'topic-1',
        MYCLAW_MEMORY_USER_ID: '5759865942',
        MYCLAW_MEMORY_DEFAULT_SCOPE: 'group',
        MYCLAW_BROWSER_PROFILE_NAME: 'c-team-abc123abc123',
        MYCLAW_ADMIN_MCP_TOOLS_JSON: '[]',
        MYCLAW_IPC_DIR: '/tmp/ipc/team',
        MYCLAW_IPC_AUTH_TOKEN: 'token',
        MYCLAW_BROWSER_IPC_AUTH_TOKEN: 'browser-token',
        MYCLAW_MEMORY_IPC_AUTH_TOKEN: 'memory-token',
        MYCLAW_IPC_RESPONSE_VERIFY_KEY: 'verify-key',
        NO_PROXY:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
        no_proxy:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
      },
    });
  });

  it('exposes global settings and service tools from selected capabilities', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:main',
      groupFolder: 'main_agent',
      isMain: false,
      configuredAllowedTools: [
        'mcp__myclaw__settings_desired_state',
        'mcp__myclaw__request_settings_update',
        'mcp__myclaw__service_restart',
        'mcp__myclaw__register_agent',
      ],
    });

    expect(profile.allowedTools).toEqual(CONFIGURED_ADMIN_ALLOWED_TOOLS);
    expect(profile.allowedTools).toContain(
      'mcp__myclaw__settings_desired_state',
    );
    expect(profile.allowedTools).toContain(
      'mcp__myclaw__request_settings_update',
    );
    expect(profile.mcpServers.myclaw?.env?.MYCLAW_ADMIN_MCP_TOOLS_JSON).toBe(
      JSON.stringify([
        'register_agent',
        'request_settings_update',
        'service_restart',
        'settings_desired_state',
      ]),
    );
  });

  it('keeps main status from granting runtime-admin tools', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:main-assistant',
      groupFolder: 'main_assistant',
      isMain: true,
    });

    expect(profile.allowedTools).toEqual(DEVELOPER_ALLOWED_TOOLS);
    expect(profile.allowedTools).toContain('Agent');
    expect(profile.allowedTools).not.toContain(
      'mcp__myclaw__settings_desired_state',
    );
    expect(profile.allowedTools).not.toContain(
      'mcp__myclaw__request_settings_update',
    );
    expect(profile.allowedTools).not.toContain('mcp__myclaw__service_restart');
    expect(profile.allowedTools).not.toContain('mcp__myclaw__register_agent');
  });

  it('defaults missing personas to developer capabilities', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:dev',
      groupFolder: 'dev',
      isMain: false,
    });

    expect(profile.allowedTools).toEqual(DEVELOPER_ALLOWED_TOOLS);
    expect(profile.allowedTools).toContain('Agent');
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).toContain('mcp__myclaw__memory_search');
    expect(profile.allowedTools).toContain('Browser');
  });

  it('fails unknown persona strings closed to assistant capabilities', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:typo',
      groupFolder: 'typo',
      persona: 'saless' as never,
      isMain: false,
    });

    expect(profile.allowedTools).toEqual(SAFE_DEFAULT_ALLOWED_TOOLS);
    expect(profile.allowedTools).not.toContain('Read');
    expect(profile.allowedTools).toContain('Agent');
    expect(profile.allowedTools).toContain('mcp__myclaw__memory_search');
    expect(profile.allowedTools).toContain('Browser');
  });

  it.each([
    'personal_assistant',
    'sales',
    'marketing',
    'operations',
    'research',
  ] as const)('keeps %s away from developer/admin tools', (persona) => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: `tg:${persona}`,
      groupFolder: persona,
      persona,
      isMain: false,
    });

    expect(profile.allowedTools).toContain('Browser');
    expect(profile.allowedTools).toContain('mcp__myclaw__memory_search');
    expect(profile.allowedTools).toContain('mcp__myclaw__memory_save');
    expect(profile.allowedTools).toContain('mcp__myclaw__procedure_save');
    expect(profile.allowedTools).not.toContain('mcp__myclaw__memory_patch');
    expect(profile.allowedTools).not.toContain('mcp__myclaw__procedure_patch');
    expect(profile.allowedTools).not.toContain('Read');
    expect(profile.allowedTools).not.toContain('Glob');
    expect(profile.allowedTools).not.toContain('Grep');
    expect(profile.allowedTools).toContain('Agent');
    expect(profile.allowedTools).not.toContain('Bash');
    expect(profile.allowedTools).not.toContain('mcp__myclaw__service_restart');
    expect(profile.allowedTools).not.toContain('mcp__myclaw__register_agent');
  });

  it('projects configured scoped SDK tool rules into developer allowed tools', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      groupFolder: 'telegram_team',
      isMain: false,
      configuredAllowedTools: ['ToolName(scope-pattern)'],
    });

    expect(profile.allowedTools).toContain('ToolName(scope-pattern)');
    expect(profile.allowedTools).not.toContain('ToolName');
  });

  it('allows exact selected admin tools but filters shell, repo, file-write, and wildcard rules for non-developer personas', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:sales',
      groupFolder: 'sales',
      persona: 'sales',
      isMain: true,
      configuredAllowedTools: [
        'Agent',
        'Browser',
        'Bash(git status)',
        'Read(/repo/**)',
        'Glob(**/*.ts)',
        'Grep(todo)',
        'LS(/repo)',
        'Write(/repo/**)',
        'Edit(/repo/**)',
        'MultiEdit(/repo/**)',
        'NotebookEdit',
        'mcp__myclaw__service_restart',
        'mcp__myclaw__settings_desired_state',
        'mcp__myclaw__*',
        'mcp__myclaw__*(service_restart)',
        'ToolName(scope-pattern)',
      ],
    });

    expect(profile.allowedTools).toContain('Agent');
    expect(profile.allowedTools).toContain('Browser');
    expect(profile.allowedTools).toContain('ToolName(scope-pattern)');
    expect(profile.allowedTools).toContain('mcp__myclaw__service_restart');
    expect(profile.allowedTools).toContain(
      'mcp__myclaw__settings_desired_state',
    );
    expect(profile.allowedTools).not.toContain('Bash(git status)');
    expect(profile.allowedTools).not.toContain('Read(/repo/**)');
    expect(profile.allowedTools).not.toContain('Glob(**/*.ts)');
    expect(profile.allowedTools).not.toContain('Grep(todo)');
    expect(profile.allowedTools).not.toContain('LS(/repo)');
    expect(profile.allowedTools).not.toContain('Write(/repo/**)');
    expect(profile.allowedTools).not.toContain('Edit(/repo/**)');
    expect(profile.allowedTools).not.toContain('MultiEdit(/repo/**)');
    expect(profile.allowedTools).not.toContain('NotebookEdit');
    expect(profile.allowedTools).not.toContain('mcp__myclaw__*');
    expect(profile.allowedTools).not.toContain(
      'mcp__myclaw__*(service_restart)',
    );
    expect(profile.mcpServers.myclaw?.env?.MYCLAW_ADMIN_MCP_TOOLS_JSON).toBe(
      JSON.stringify(['service_restart', 'settings_desired_state']),
    );
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
    expect(profile.allowedTools).toEqual(DEVELOPER_ALLOWED_TOOLS);
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
          args: ['--shared-browser-context'],
          env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:4567' },
        },
      },
      externalMcpAllowedTools: ['mcp__agent_browser__*'],
    });

    expect(profile.mcpServers.agent_browser).toEqual({
      type: 'stdio',
      command: '/tmp/playwright-mcp',
      args: ['--shared-browser-context'],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:4567' },
    });
    expect(profile.allowedTools).not.toContain('mcp__myclaw__*');
    expect(profile.allowedTools).toContain('mcp__agent_browser__*');
  });
});
