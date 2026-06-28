import { describe, expect, it } from 'vitest';

import {
  BUILTIN_AGENT_CAPABILITY_PROVIDERS,
  composeAgentCapabilities,
  type AgentCapabilityProvider,
} from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import {
  ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  BASELINE_GANTRY_MCP_TOOL_NAMES,
  DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  DEFAULT_GANTRY_MCP_TOOL_NAMES,
  NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES,
  gantryMcpFullToolName,
  selectedMemoryIpcActions,
  selectedGantryMcpToolNames,
} from '@agent-runner-src/gantry-mcp-tool-surface.js';

const SAFE_DEFAULT_ALLOWED_TOOLS = [
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
  ...BASELINE_GANTRY_MCP_TOOL_NAMES.map(gantryMcpFullToolName),
] as const;

const DEVELOPER_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  ...SAFE_DEFAULT_ALLOWED_TOOLS,
] as const;

const CONFIGURED_ADMIN_ALLOWED_TOOLS = [
  ...DEVELOPER_ALLOWED_TOOLS,
  'mcp__gantry__settings_desired_state',
  'mcp__gantry__request_settings_update',
  'mcp__gantry__service_restart',
  'mcp__gantry__register_agent',
] as const;

const DANGEROUS_DEFAULT_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Config',
  'Agent',
  'AskUserQuestion',
  'SendMessage',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'EnterWorktree',
  'ExitWorktree',
  'mcp__gantry__list_models',
  'mcp__gantry__*',
] as const;

const UNAVAILABLE_DEFAULT_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'Write',
  'Edit',
  'LS',
  'MultiEdit',
  'NotebookEdit',
  'Browser',
  'Config',
  'Agent',
  'AskUserQuestion',
  'SendMessage',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'EnterWorktree',
  'ExitWorktree',
  'mcp__gantry__list_models',
  'mcp__gantry__*',
] as const;

const DEFAULT_AVAILABLE_TOOLS = [
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
] as const;

const DEVELOPER_AVAILABLE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'Edit',
  'Write',
  'LS',
  'MultiEdit',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
] as const;

describe('agent capability composition', () => {
  it('uses exact safe defaults and gantry MCP server wiring', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      appId: 'app-main',
      agentId: 'agent:telegram_team',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      threadId: 'topic-1',
      memoryUserId: '5759865942',
      browserProfileName: 'c-team-abc123abc123',
      ipcDir: '/tmp/ipc/team',
      ipcAuthToken: 'token',
      browserIpcAuthToken: 'browser-token',
      memoryIpcAuthToken: 'memory-token',
      ipcResponseVerifyKey: 'verify-key',
      ipcResponseKeyId: 'verify-key-id',
      liveStopActionToken: 'stop-token-1',
      persona: 'generalist',
    });

    expect(profile.allowedTools).toEqual(SAFE_DEFAULT_ALLOWED_TOOLS);
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
    expect(profile.disallowedTools).toEqual(
      expect.arrayContaining([
        'AskUserQuestion',
        'SendMessage',
        'CronCreate',
        'TaskOutput',
        'TaskStop',
        'EnterWorktree',
        'ExitWorktree',
        'TodoWrite',
      ]),
    );
    for (const tool of DANGEROUS_DEFAULT_TOOLS) {
      expect(profile.allowedTools).not.toContain(tool);
    }
    expect(profile.allowedTools).toContain('mcp__gantry__continuity_summary');
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__memory_review_pending',
    );
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__memory_review_decision',
    );
    expect(selectedMemoryIpcActions([])).toContain('continuity_summary');
    expect(selectedMemoryIpcActions([])).not.toContain('memory_review_pending');
    expect(selectedMemoryIpcActions([])).not.toContain(
      'memory_review_decision',
    );
    for (const tool of UNAVAILABLE_DEFAULT_TOOLS) {
      expect(profile.allowedTools).not.toContain(tool);
    }
    expect(profile.permissionMode).toBe('default');
    expect(profile.alwaysAllowedTools).toEqual([]);
    expect(profile.mcpServers.gantry).toEqual({
      command: 'node',
      args: ['/tmp/ipc-mcp-stdio.js'],
      timeout: 300_000,
      alwaysLoad: true,
      env: {
        GANTRY_APP_ID: 'app-main',
        GANTRY_AGENT_ID: 'agent:telegram_team',
        GANTRY_CHAT_JID: 'tg:team',
        GANTRY_WORKSPACE_KEY: 'telegram_team',
        GANTRY_THREAD_ID: 'topic-1',
        GANTRY_MEMORY_USER_ID: '5759865942',
        GANTRY_MEMORY_DEFAULT_SCOPE: 'group',
        GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER: '',
        GANTRY_BROWSER_PROFILE_NAME: 'c-team-abc123abc123',
        GANTRY_ADMIN_MCP_TOOLS_JSON: '[]',
        GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: '[]',
        GANTRY_SEMANTIC_CAPABILITIES_JSON: '[]',
        GANTRY_SELECTED_SKILLS_JSON: '[]',
        GANTRY_SELECTED_SKILL_DISPLAYS_JSON: '[]',
        GANTRY_SELECTED_MCP_SERVERS_JSON: '[]',
        GANTRY_MCP_TOOL_NAMES_JSON: JSON.stringify(
          selectedGantryMcpToolNames([]),
        ),
        GANTRY_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(
          selectedMemoryIpcActions([]),
        ),
        GANTRY_IPC_DIR: '/tmp/ipc/team',
        GANTRY_IPC_AUTH_TOKEN: 'token',
        GANTRY_MEMORY_IPC_AUTH_TOKEN: 'memory-token',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: 'verify-key',
        GANTRY_IPC_RESPONSE_KEY_ID: 'verify-key-id',
        GANTRY_LIVE_STOP_ACTION_TOKEN: 'stop-token-1',
        NO_PROXY:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
        no_proxy:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
      },
    });
  });

  it('keeps request_access visible when MCP access is only requestable', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      appId: 'default',
      agentId: 'agent:main_agent',
      chatJid: 'sl:C0B3M99H1B6',
      groupFolder: 'main_agent',
      ipcDir: '/tmp/ipc/main_agent',
      ipcAuthToken: 'token',
      persona: 'operations',
      semanticCapabilities: [
        {
          capabilityId: 'mcp.caw-ats.access',
          version: '1',
          displayName: 'caw-ats MCP access',
          category: 'MCP',
          risk: 'write',
          can: 'Call approved tools on the caw-ats MCP server.',
          cannot: 'Bypass Gantry capability review.',
          credentialSource: 'none',
          implementationBindings: [
            {
              kind: 'mcp_tool',
              mcpTool: 'mcp__caw-ats__ats_list_positions',
            },
          ],
          source: {
            source: 'mcp',
            serverName: 'caw-ats',
            allowedToolPatterns: ['ats_list_positions'],
          },
        },
      ],
    });

    expect(profile.allowedTools).toContain('mcp__gantry__request_access');
    expect(profile.alwaysAllowedTools).not.toContain(
      'mcp__gantry__request_access',
    );
    expect(profile.disallowedTools).not.toContain(
      'mcp__gantry__request_access',
    );
    expect(
      JSON.parse(
        String(profile.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON),
      ),
    ).toContain('request_access');
    expect(profile.allowedTools).toContain('mcp__gantry__mcp_list_tools');
    expect(profile.allowedTools).toContain('mcp__gantry__mcp_describe_tool');
    expect(profile.allowedTools).toContain('mcp__gantry__mcp_call_tool');
  });

  it('keeps request_access visible when an MCP source is attached for the run', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      appId: 'default',
      agentId: 'agent:main_agent',
      chatJid: 'sl:C0B3M99H1B6',
      groupFolder: 'main_agent',
      ipcDir: '/tmp/ipc/main_agent',
      ipcAuthToken: 'token',
      persona: 'operations',
      attachedMcpSourceIds: ['mcp:00dab2e4-3c5c-4d5c-b7f3-be05f2f38d49'],
    });

    expect(profile.allowedTools).toContain('mcp__gantry__request_access');
    expect(profile.disallowedTools).not.toContain(
      'mcp__gantry__request_access',
    );
    expect(
      JSON.parse(
        String(profile.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON),
      ),
    ).toContain('request_access');
    expect(profile.allowedTools).toContain('mcp__gantry__mcp_list_tools');
    expect(profile.allowedTools).toContain('mcp__gantry__mcp_describe_tool');
    expect(profile.allowedTools).toContain('mcp__gantry__mcp_call_tool');
  });

  it('projects the browser IPC token only when canonical Browser is selected', () => {
    const withoutBrowser = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      browserIpcAuthToken: 'browser-token',
      configuredAllowedTools: ['mcp__gantry__browser'],
    });
    expect(
      withoutBrowser.mcpServers.gantry?.env?.GANTRY_BROWSER_IPC_AUTH_TOKEN,
    ).toBeUndefined();
    expect(withoutBrowser.allowedTools).not.toContain('mcp__gantry__browser');
    expect(
      JSON.parse(
        String(
          withoutBrowser.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON,
        ),
      ),
    ).not.toContain('browser');

    const withBrowser = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      browserIpcAuthToken: 'browser-token',
      configuredAllowedTools: ['Browser'],
    });
    expect(
      withBrowser.mcpServers.gantry?.env?.GANTRY_BROWSER_IPC_AUTH_TOKEN,
    ).toBe('browser-token');
  });

  it('projects scheduled job identity into the Gantry MCP env', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      configuredAllowedTools: ['Browser'],
      jobId: 'job-1',
      runId: 'run-1',
      runLeaseToken: 'lease-1',
      runLeaseFencingVersion: 7,
    });

    expect(profile.mcpServers.gantry?.env).toMatchObject({
      GANTRY_JOB_ID: 'job-1',
      GANTRY_JOB_RUN_ID: 'run-1',
      GANTRY_JOB_RUN_LEASE_TOKEN: 'lease-1',
      GANTRY_JOB_RUN_LEASE_FENCING_VERSION: '7',
    });
  });

  it('projects selected global settings and service admin tools', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:main',
      workspaceFolder: 'main_agent',
      configuredAllowedTools: [
        'mcp__gantry__settings_desired_state',
        'mcp__gantry__request_settings_update',
        'mcp__gantry__service_restart',
        'mcp__gantry__register_agent',
      ],
    });

    expect(profile.allowedTools).toEqual(CONFIGURED_ADMIN_ALLOWED_TOOLS);
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
    expect(profile.allowedTools).toContain(
      'mcp__gantry__settings_desired_state',
    );
    expect(profile.allowedTools).toContain(
      'mcp__gantry__request_settings_update',
    );
    expect(profile.mcpServers.gantry?.env?.GANTRY_ADMIN_MCP_TOOLS_JSON).toBe(
      JSON.stringify([
        'register_agent',
        'request_settings_update',
        'service_restart',
        'settings_desired_state',
      ]),
    );
    expect(profile.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON).toBe(
      JSON.stringify(
        selectedGantryMcpToolNames([
          'mcp__gantry__settings_desired_state',
          'mcp__gantry__request_settings_update',
          'mcp__gantry__service_restart',
          'mcp__gantry__register_agent',
        ]),
      ),
    );
  });

  it('keeps main status from granting runtime-admin tools', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:main-assistant',
      workspaceFolder: 'main_assistant',
    });

    expect(profile.allowedTools).toEqual(DEVELOPER_ALLOWED_TOOLS);
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
    expect(profile.allowedTools).not.toContain('Agent');
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__settings_desired_state',
    );
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__request_settings_update',
    );
    expect(profile.allowedTools).not.toContain('mcp__gantry__service_restart');
    expect(profile.allowedTools).not.toContain('mcp__gantry__register_agent');
  });

  it('defaults missing personas to developer capabilities', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:dev',
      workspaceFolder: 'dev',
    });

    expect(profile.allowedTools).toEqual(DEVELOPER_ALLOWED_TOOLS);
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
    expect(profile.allowedTools).not.toContain('Agent');
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).toContain('mcp__gantry__memory_search');
    expect(profile.allowedTools).not.toContain('Browser');
  });

  it('fails unknown persona strings closed to assistant capabilities', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:typo',
      workspaceFolder: 'typo',
      persona: 'saless' as never,
    });

    expect(profile.allowedTools).toEqual(SAFE_DEFAULT_ALLOWED_TOOLS);
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
    expect(profile.allowedTools).not.toContain('Read');
    expect(profile.allowedTools).not.toContain('Agent');
    expect(profile.allowedTools).toContain('mcp__gantry__memory_search');
    expect(profile.allowedTools).not.toContain('Browser');
  });

  it.each([
    'generalist',
    'sales',
    'marketing',
    'operations',
    'research',
  ] as const)('keeps %s away from developer/admin tools', (persona) => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: `tg:${persona}`,
      workspaceFolder: persona,
      persona,
    });

    expect(profile.allowedTools).not.toContain('Browser');
    expect(profile.availableTools).not.toContain('Browser');
    expect(profile.allowedTools).toContain('mcp__gantry__memory_search');
    expect(profile.allowedTools).toContain('mcp__gantry__memory_save');
    expect(profile.allowedTools).toContain('mcp__gantry__procedure_save');
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__scheduler_list_jobs',
    );
    expect(profile.allowedTools).not.toContain('Read');
    expect(profile.allowedTools).not.toContain('Glob');
    expect(profile.allowedTools).not.toContain('Grep');
    expect(profile.allowedTools).not.toContain('Agent');
    expect(profile.allowedTools).not.toContain('Bash');
    expect(profile.allowedTools).not.toContain('mcp__gantry__service_restart');
    expect(profile.allowedTools).not.toContain('mcp__gantry__register_agent');
  });

  it('keeps memory mutation tools out of the user-facing runner', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:sales',
      workspaceFolder: 'sales',
      persona: 'sales',
      configuredAllowedTools: [
        'mcp__gantry__memory_patch',
        'mcp__gantry__memory_demote',
        'mcp__gantry__procedure_patch',
      ],
    });

    expect(profile.allowedTools).not.toContain('mcp__gantry__memory_patch');
    expect(profile.allowedTools).not.toContain('mcp__gantry__memory_demote');
    expect(profile.allowedTools).not.toContain('mcp__gantry__procedure_patch');
    expect(selectedMemoryIpcActions([])).not.toContain('memory_patch');
    expect(selectedMemoryIpcActions([])).not.toContain('memory_demote');
    expect(
      selectedMemoryIpcActions([
        'mcp__gantry__memory_patch',
        'mcp__gantry__memory_demote',
        'mcp__gantry__procedure_patch',
      ]),
    ).toEqual([
      'memory_search',
      'memory_save',
      'memory_patch',
      'memory_demote',
      'continuity_summary',
      'procedure_save',
      'procedure_patch',
    ]);
  });

  it('keeps memory review tools out of the user-facing runner', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:sales',
      workspaceFolder: 'sales',
      persona: 'sales',
      memoryReviewerIsControlApprover: true,
    });

    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__memory_review_pending',
    );
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__memory_review_decision',
    );
    expect(profile.allowedTools).not.toContain('mcp__gantry__memory_patch');
    expect(profile.allowedTools).not.toContain('mcp__gantry__memory_demote');
    expect(profile.allowedTools).not.toContain('mcp__gantry__procedure_patch');
    expect(profile.mcpServers.gantry?.env).toMatchObject({
      GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER: '1',
    });

    const projectedToolNames = JSON.parse(
      String(profile.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON),
    ) as string[];
    expect(projectedToolNames).not.toContain('memory_review_pending');
    expect(projectedToolNames).not.toContain('memory_review_decision');
    expect(
      JSON.parse(
        String(profile.mcpServers.gantry?.env?.GANTRY_MEMORY_IPC_ACTIONS_JSON),
      ),
    ).toEqual(
      expect.arrayContaining([
        'memory_review_pending',
        'memory_review_decision',
      ]),
    );
    expect(
      selectedMemoryIpcActions([], {
        memoryReviewerIsControlApprover: true,
      }),
    ).toEqual([
      'memory_search',
      'memory_save',
      'continuity_summary',
      'memory_review_pending',
      'memory_review_decision',
      'procedure_save',
    ]);
  });

  it('keeps scoped RunCommand available but does not project it as SDK always-allowed', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      configuredAllowedTools: [
        'RunCommand(npm test *)',
        'ToolName(scope-pattern)',
        'RunCommand(npm test',
        'Read(/repo/**)',
      ],
    });

    expect(profile.allowedTools).not.toContain('Bash');
    expect(profile.allowedTools).not.toContain('RunCommand(npm test *)');
    expect(profile.availableTools).toContain('Bash');
    expect(profile.allowedTools).not.toContain('ToolName(scope-pattern)');
    expect(profile.availableTools).not.toContain('ToolName');
    expect(profile.allowedTools).not.toContain('RunCommand(npm test');
    expect(
      profile.availableTools.filter((tool) => tool === 'Bash'),
    ).toHaveLength(1);
    expect(profile.allowedTools).not.toContain('Read(/repo/**)');
  });

  it('does not expose unselected permission-gated native tools to scheduled jobs', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:sales',
      workspaceFolder: 'sales',
      persona: 'sales',
      isScheduledJob: true,
      configuredAllowedTools: [
        'FileRead',
        'RunCommand(/usr/local/bin/acme records append *)',
        'RunCommand(python3 /Users/example/scripts/dedup-append-lead.py)',
      ],
    });

    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).not.toContain('Bash');
    expect(profile.allowedTools).not.toContain(
      'RunCommand(/usr/local/bin/acme records append *)',
    );
    expect(profile.availableTools).toEqual(
      expect.arrayContaining([
        'WebSearch',
        'WebFetch',
        'ToolSearch',
        'Skill',
        'Read',
        'Bash',
      ]),
    );
    expect(profile.availableTools).not.toContain('Glob');
    expect(profile.availableTools).not.toContain('Grep');
    expect(profile.availableTools).not.toContain('Write');
    expect(profile.availableTools).not.toContain('Edit');
    expect(profile.availableTools).not.toContain('MultiEdit');
    expect(profile.availableTools).not.toContain('NotebookEdit');
  });

  it('projects selected Gantry facade tools but filters provider-native and unsupported wildcard rules for non-developer personas', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:sales',
      workspaceFolder: 'sales',
      persona: 'sales',
      configuredAllowedTools: [
        'AgentDelegation',
        'WebSearch',
        'WebRead',
        'FileRead',
        'FileSearch',
        'FileWrite',
        'FileEdit',
        'Agent',
        'Browser',
        'Bash',
        'Read',
        'Glob',
        'Grep',
        'LS',
        'Write',
        'Edit',
        'MultiEdit',
        'NotebookEdit',
        'mcp__gantry__service_restart',
        'mcp__gantry__settings_desired_state',
        'mcp__gantry__*',
        'mcp__gantry__*(service_restart)',
        'ToolName(scope-pattern)',
      ],
    });

    expect(profile.allowedTools).not.toContain('Agent');
    expect(profile.allowedTools).not.toContain('mcp__gantry__delegate_task');
    expect(profile.allowedTools).not.toContain('Browser');
    expect(profile.allowedTools).not.toContain('ToolName(scope-pattern)');
    expect(profile.allowedTools).not.toContain('AgentDelegation');
    expect(profile.allowedTools).not.toContain('FileRead');
    expect(profile.allowedTools).not.toContain('FileSearch');
    expect(profile.allowedTools).not.toContain('FileWrite');
    expect(profile.allowedTools).not.toContain('FileEdit');
    expect(profile.allowedTools).toContain('mcp__gantry__service_restart');
    expect(profile.allowedTools).toContain(
      'mcp__gantry__settings_desired_state',
    );
    expect(profile.allowedTools).not.toContain('Bash');
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).toContain('Glob');
    expect(profile.allowedTools).toContain('Grep');
    expect(profile.allowedTools).toContain('Write');
    expect(profile.allowedTools).toContain('Edit');
    expect(profile.allowedTools).toContain('MultiEdit');
    expect(profile.allowedTools).toContain('WebFetch');
    expect(profile.allowedTools).not.toContain('LS');
    expect(profile.allowedTools).not.toContain('NotebookEdit');
    expect(profile.allowedTools).not.toContain('mcp__gantry__*');
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__*(service_restart)',
    );
    expect(profile.mcpServers.gantry?.env?.GANTRY_ADMIN_MCP_TOOLS_JSON).toBe(
      JSON.stringify(['service_restart', 'settings_desired_state']),
    );
    expect(profile.mcpServers.gantry?.env?.GANTRY_SELECTED_SKILLS_JSON).toBe(
      JSON.stringify([]),
    );
    expect(
      profile.mcpServers.gantry?.env?.GANTRY_SELECTED_SKILL_DISPLAYS_JSON,
    ).toBe(JSON.stringify([]));
  });

  it('allows mounted async task tools when the runtime enables them', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      appId: 'app-main',
      agentId: 'agent:telegram_team',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      ipcDir: '/tmp/ipc/team',
      ipcAuthToken: 'token',
      memoryIpcAuthToken: 'memory-token',
      ipcResponseVerifyKey: 'verify-key',
      ipcResponseKeyId: 'verify-key-id',
      asyncTaskToolsEnabled: true,
    });

    for (const toolName of ASYNC_TASK_GANTRY_MCP_TOOL_NAMES) {
      expect(profile.allowedTools).toContain(gantryMcpFullToolName(toolName));
    }
    for (const toolName of DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES) {
      expect(profile.allowedTools).not.toContain(
        gantryMcpFullToolName(toolName),
      );
    }
    expect(profile.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON).toBe(
      JSON.stringify(
        selectedGantryMcpToolNames([], { asyncTaskToolsEnabled: true }),
      ),
    );

    const delegatedProfile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      appId: 'app-main',
      agentId: 'agent:telegram_team',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      parentTaskId: 'task_parent',
      configuredAllowedTools: ['AgentDelegation'],
      asyncTaskToolsEnabled: true,
    });
    for (const toolName of DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES) {
      expect(delegatedProfile.allowedTools).toContain(
        gantryMcpFullToolName(toolName),
      );
    }
    expect(delegatedProfile.mcpServers.gantry?.env?.GANTRY_PARENT_TASK_ID).toBe(
      'task_parent',
    );
  });

  it('projects selected skills and MCP servers into capability_status environment', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:sales',
      workspaceFolder: 'sales',
      attachedSkillSourceIds: ['skill:release'],
      selectedSkillDisplays: ['release (skill:release)'],
      attachedMcpSourceIds: ['mcp:github'],
    });

    expect(profile.mcpServers.gantry?.env?.GANTRY_SELECTED_SKILLS_JSON).toBe(
      JSON.stringify(['skill:release']),
    );
    expect(
      profile.mcpServers.gantry?.env?.GANTRY_SELECTED_SKILL_DISPLAYS_JSON,
    ).toBe(JSON.stringify(['release (skill:release)']));
    expect(
      profile.mcpServers.gantry?.env?.GANTRY_SELECTED_MCP_SERVERS_JSON,
    ).toBe(JSON.stringify(['mcp:github']));
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
        workspaceFolder: 'telegram_team',
      },
      [...BUILTIN_AGENT_CAPABILITY_PROVIDERS, extraProvider],
    );
    expect(profile.allowedTools).toContain('CustomTool');
    expect(profile.allowedTools).toContain('mcp__gantry__send_message');
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
    expect(profile.allowedTools).not.toContain('mcp__gantry__*');
    expect(profile.alwaysAllowedTools).toContain('CustomTool');
  });

  it('exposes approved third-party stdio MCP servers through direct SDK MCP config', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      externalMcpServers: {
        github: {
          type: 'stdio',
          command: '/tmp/github-mcp',
          args: ['--stdio'],
          env: { GITHUB_TOKEN: 'broker-safe-token' },
        },
      },
      externalMcpAllowedTools: [
        'Bash',
        'Read',
        'Browser',
        'mcp__browser' + '_' + 'backend' + '__*',
        'mcp__gantry__service_restart',
        'mcp__github__search_repositories',
        'mcp__github__issues.create',
        'mcp__github__*',
        'mcp__linear__search',
      ],
      externalMcpAlwaysAllowedTools: [
        'mcp__github__search_repositories',
        'mcp__github__issues.create',
        'mcp__gantry__service_restart',
      ],
    });

    expect(profile.mcpServers.gantry).toMatchObject({
      command: 'node',
    });
    expect(profile.mcpServers.github).toEqual({
      type: 'stdio',
      command: '/tmp/github-mcp',
      args: ['--stdio'],
      env: { GITHUB_TOKEN: 'broker-safe-token' },
    });
    expect(profile.allowedTools).toEqual([
      ...DEVELOPER_ALLOWED_TOOLS,
      'mcp__github__search_repositories',
      'mcp__github__issues.create',
      'mcp__github__*',
    ]);
    expect(profile.allowedTools).not.toContain('Bash');
    expect(profile.allowedTools).not.toContain('Browser');
    expect(profile.allowedTools).not.toContain(
      'mcp__browser' + '_' + 'backend' + '__*',
    );
    expect(profile.allowedTools).not.toContain('mcp__gantry__service_restart');
    expect(profile.allowedTools).not.toContain('mcp__linear__search');
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
    expect(profile.alwaysAllowedTools).toEqual([
      'mcp__github__search_repositories',
      'mcp__github__issues.create',
    ]);
  });

  it('does not expose remote MCP servers directly to the SDK', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      externalMcpServers: {
        github: {
          type: 'http',
          url: 'https://mcp.example.test/github',
        },
      },
      externalMcpAllowedTools: ['mcp__github__search_repositories'],
      externalMcpAlwaysAllowedTools: ['mcp__github__search_repositories'],
    });

    expect(profile.mcpServers.github).toBeUndefined();
    expect(profile.allowedTools).not.toContain(
      'mcp__github__search_repositories',
    );
    expect(profile.alwaysAllowedTools).toEqual([]);
  });

  it('hides authority-changing request/admin tools but keeps safe baseline', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:user',
      workspaceFolder: 'user_agent',
      hideAuthorityTools: true,
      configuredAllowedTools: [
        'mcp__gantry__request_access',
        'mcp__gantry__request_skill_install',
        'mcp__gantry__request_mcp_server',
        'mcp__gantry__request_agent_profile_update',
        'mcp__gantry__settings_desired_state',
        'mcp__gantry__request_settings_update',
        'mcp__gantry__service_restart',
        'mcp__gantry__register_agent',
      ],
    });

    // Authority-changing, scheduler, and reviewed mutation tools are not
    // projected as allowed tools.
    for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
      expect(profile.allowedTools).not.toContain(
        gantryMcpFullToolName(toolName),
      );
    }
    // Explicitly selected admin tools are registered server-side, but are not
    // projected as SDK-allowed tools in no-permission mode.
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__settings_desired_state',
    );
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__request_settings_update',
    );
    expect(profile.allowedTools).not.toContain('mcp__gantry__service_restart');
    expect(profile.allowedTools).not.toContain('mcp__gantry__register_agent');

    // Safe baseline tools remain available.
    expect(profile.allowedTools).toContain('mcp__gantry__send_message');
    expect(profile.allowedTools).toContain('mcp__gantry__ask_user_question');
    expect(profile.allowedTools).toContain('mcp__gantry__memory_search');
    expect(profile.allowedTools).toContain('mcp__gantry__continuity_summary');
    expect(profile.allowedTools).toContain('mcp__gantry__agent_profile_read');

    // Env projection: selected admin env is separate; tool list excludes authority.
    expect(profile.mcpServers.gantry?.env?.GANTRY_ADMIN_MCP_TOOLS_JSON).toBe(
      JSON.stringify([
        'register_agent',
        'request_settings_update',
        'service_restart',
        'settings_desired_state',
      ]),
    );
    const projectedToolNames = JSON.parse(
      String(profile.mcpServers.gantry?.env?.GANTRY_MCP_TOOL_NAMES_JSON),
    ) as string[];
    for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
      expect(projectedToolNames).not.toContain(toolName);
    }
    expect(projectedToolNames).toContain('send_message');
    expect(projectedToolNames).toContain('agent_profile_read');
  });

  it('allows explicitly selected scheduler and reviewed Gantry tools', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      configuredAllowedTools: [
        'mcp__gantry__scheduler_run_now',
        'mcp__gantry__memory_review_decision',
      ],
    });

    expect(profile.allowedTools).toContain('mcp__gantry__scheduler_run_now');
    expect(profile.allowedTools).toContain(
      'mcp__gantry__memory_review_decision',
    );
  });

  it('denies permission prompts but keeps pre-provisioned skills and MCP tools for a locked agent', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:support',
      workspaceFolder: 'support_agent',
      accessPreset: 'locked',
      hideAuthorityTools: true,
      attachedSkillSourceIds: ['skill:refunds'],
      attachedMcpSourceIds: ['mcp:crm'],
      externalMcpServers: {
        crm: {
          type: 'stdio',
          command: 'node',
          args: ['crm.js'],
        },
      },
      externalMcpAllowedTools: ['mcp__crm__lookup_order'],
      configuredAllowedTools: [
        'mcp__gantry__request_access',
        'mcp__gantry__request_skill_install',
        'mcp__gantry__service_restart',
      ],
    });

    // Locked agents auto-deny permission prompts.
    expect(profile.permissionMode).toBe('deny');

    // Authority/admin tools are never projected.
    for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
      expect(profile.allowedTools).not.toContain(
        gantryMcpFullToolName(toolName),
      );
    }
    expect(profile.allowedTools).not.toContain('mcp__gantry__service_restart');

    // Pre-provisioned skill and MCP source projections still work.
    expect(profile.mcpServers.crm).toBeDefined();
    expect(profile.allowedTools).toContain('mcp__crm__lookup_order');
    expect(profile.mcpServers.gantry?.env?.GANTRY_SELECTED_SKILLS_JSON).toBe(
      JSON.stringify(['skill:refunds']),
    );
    expect(
      profile.mcpServers.gantry?.env?.GANTRY_SELECTED_MCP_SERVERS_JSON,
    ).toBe(JSON.stringify(['mcp:crm']));

    // Baseline messaging/profile-read tools still mount.
    expect(profile.allowedTools).toContain('mcp__gantry__send_message');
    expect(profile.allowedTools).toContain('mcp__gantry__agent_profile_read');
  });

  it('keeps the default permission mode for a full-preset agent', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      accessPreset: 'full',
    });
    expect(profile.permissionMode).toBe('default');
  });

  it('does not expose raw runtime browser MCP servers as configured MCP input', () => {
    const hostPrivateServerName = `${'browser'}_${'backend'}`;
    const hiddenRuntimeServerName = `${'agent'}_${'browser'}`;
    const hiddenPackageServerName = `${'play'}${'wright'}`;
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
      externalMcpServers: {
        [hostPrivateServerName]: {
          type: 'stdio',
          command: '/tmp/private-browser-mcp',
          args: ['--unsafe-shared-context'],
          env: { RAW_BROWSER_BACKEND_ENDPOINT: 'http://127.0.0.1:4567' },
        },
        [hiddenRuntimeServerName]: {
          type: 'stdio',
          command: '/tmp/hidden-runtime-browser',
          args: ['--unsafe-shared-context'],
        },
        [hiddenPackageServerName]: {
          type: 'stdio',
          command: '/tmp/hidden-package-browser',
          args: ['--unsafe-shared-context'],
        },
      },
      externalMcpAllowedTools: [
        'mcp__browser' + '_' + 'backend' + '__*',
        `${'mcp__agent'}_${'browser'}__*`,
        `mcp__${'play'}${'wright'}__click`,
      ],
    });

    expect(profile.mcpServers[hostPrivateServerName]).toBeUndefined();
    expect(profile.mcpServers[hiddenRuntimeServerName]).toBeUndefined();
    expect(profile.mcpServers[hiddenPackageServerName]).toBeUndefined();
    expect(profile.allowedTools).not.toContain('mcp__gantry__*');
    expect(profile.allowedTools).not.toContain(
      'mcp__browser' + '_' + 'backend' + '__*',
    );
    expect(profile.allowedTools).not.toContain(
      `${'mcp__agent'}_${'browser'}__*`,
    );
    expect(profile.allowedTools).not.toContain(
      `mcp__${'play'}${'wright'}__click`,
    );
    expect(profile.availableTools).toEqual(DEVELOPER_AVAILABLE_TOOLS);
  });
});
