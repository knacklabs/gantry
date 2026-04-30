import { describe, expect, it } from 'vitest';

import {
  BUILTIN_AGENT_CAPABILITY_PROVIDERS,
  composeAgentCapabilities,
  type AgentCapabilityProvider,
} from '@agent-runner-src/agent-capabilities.js';

describe('agent capability composition', () => {
  it('keeps the default built-in tools and myclaw MCP server wiring', () => {
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

    expect(profile.allowedTools).toContain('Bash');
    expect(profile.allowedTools).toContain('mcp__myclaw__*');
    expect(profile.permissionMode).toBe('default');
    expect(profile.alwaysAllowedTools).toEqual(
      expect.arrayContaining(['EnterWorktree', 'ExitWorktree']),
    );
    expect(profile.alwaysAllowedTools).not.toContain('Config');
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
    expect(profile.allowedTools).toContain('mcp__myclaw__*');
    expect(profile.alwaysAllowedTools).toContain('CustomTool');
  });

  it('merges approved external MCP servers without overriding the built-in server', () => {
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
    expect(profile.mcpServers.github).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/github',
      headers: { Authorization: 'broker-safe-token' },
    });
    expect(profile.allowedTools).toContain('mcp__myclaw__*');
    expect(profile.allowedTools).toContain('mcp__github__search_repositories');
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
    expect(profile.allowedTools).toContain('mcp__agent_browser__*');
  });
});
