import { describe, expect, it } from 'vitest';

import { buildGantryMcpProjection } from '@core/adapters/llm/deepagents-langchain/runner/gantry-mcp-env.js';
import {
  callableAgentToolName,
  projectCallableAgentTools,
} from '@core/application/core-tools/callable-agent-tools.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  GANTRY_IPC_DIR: '/ipc',
  GANTRY_IPC_AUTH_TOKEN: 'ipc-token',
  GANTRY_IPC_RESPONSE_VERIFY_KEY: 'verify-key',
  GANTRY_IPC_RESPONSE_KEY_ID: 'key-id',
  GANTRY_APP_ID: 'default',
  GANTRY_AGENT_ID: 'agent:main_agent',
  GANTRY_CHAT_JID: 'tg:group',
  GANTRY_PARENT_TASK_ID: 'task_parent',
  GANTRY_LIVE_STOP_ACTION_TOKEN: 'stop-token-1',
  GANTRY_WORKSPACE_KEY: 'main_agent',
  GANTRY_MEMORY_USER_ID: 'user-1',
  GANTRY_MEMORY_DEFAULT_SCOPE: 'group',
};

describe('buildGantryMcpProjection', () => {
  const callableAgentManifest = projectCallableAgentTools({
    agents: [
      {
        id: 'agent:main_agent',
        appId: 'default',
        name: 'Main',
        status: 'active',
      },
      {
        id: 'agent:reviewer',
        appId: 'default',
        name: 'Reviewer',
        status: 'active',
      },
    ] as never,
    callerAppId: 'default',
    callerAgentId: 'agent:main_agent',
    callerFolder: 'main_agent',
    delegates: ['reviewer'],
    conversationBoundAgentIds: new Set(['agent:reviewer']),
    toolPolicyRules: ['AgentDelegation'],
  });
  const callableAgentTool = callableAgentToolName(callableAgentManifest[0]!);

  it('projects callable-agent tools into the DeepAgents lane', () => {
    const projection = buildGantryMcpProjection({
      configuredAllowedTools: ['AgentDelegation'],
      hideAuthorityTools: false,
      callableAgentManifest,
      processEnv: {
        ...BASE_ENV,
        GANTRY_PARENT_TASK_ID: undefined,
        GANTRY_AGENT_ACCESS_PRESET: 'full',
        GANTRY_ASYNC_TASK_TOOLS_ENABLED: '1',
      },
    });

    expect(projection.selectedToolNames).toContain(callableAgentTool);
    expect(
      JSON.parse(projection.env.GANTRY_CALLABLE_AGENT_MANIFEST_JSON),
    ).toEqual(callableAgentManifest);
  });

  it.each([
    [
      'delegated child',
      { GANTRY_PARENT_TASK_ID: 'task_parent' },
      callableAgentManifest,
    ],
    [
      'locked mode',
      { GANTRY_AGENT_ACCESS_PRESET: 'locked' },
      callableAgentManifest,
    ],
    ['empty allowlist', {}, []],
  ])(
    'suppresses callable-agent tools for %s in the DeepAgents lane',
    (_name, env, manifest) => {
      const projection = buildGantryMcpProjection({
        configuredAllowedTools: ['AgentDelegation'],
        hideAuthorityTools: false,
        callableAgentManifest: manifest,
        processEnv: {
          ...BASE_ENV,
          GANTRY_PARENT_TASK_ID: undefined,
          GANTRY_AGENT_ACCESS_PRESET: 'full',
          GANTRY_ASYNC_TASK_TOOLS_ENABLED: '1',
          ...env,
        },
      });

      expect(projection.selectedToolNames).not.toContain(callableAgentTool);
      expect(
        JSON.parse(projection.env.GANTRY_CALLABLE_AGENT_MANIFEST_JSON),
      ).toEqual([]);
    },
  );
  it('projects the baseline gantry tool surface and core env passthrough', () => {
    const projection = buildGantryMcpProjection({
      configuredAllowedTools: [],
      hideAuthorityTools: false,
      processEnv: BASE_ENV,
    });
    // Default agent surface is mounted (send_message etc.).
    expect(projection.selectedToolNames).toContain('send_message');
    expect(projection.selectedToolNames).toContain('ask_user_question');
    expect(projection.selectedToolNames).toContain('todo_update');
    expect(projection.selectedToolNames).toContain('memory_search');
    // No Browser selected and no browser IPC token -> browser tools absent.
    expect(projection.browserIpcEnabled).toBe(false);
    expect(projection.selectedToolNames).not.toContain('browser_open');
    expect(projection.selectedToolNames).not.toContain('browser_status');
    // Env block passes the IPC tokens to the spawned gantry MCP server and
    // carries the selected tool-name JSON.
    expect(projection.env.GANTRY_IPC_DIR).toBe('/ipc');
    expect(projection.env.GANTRY_IPC_AUTH_TOKEN).toBe('ipc-token');
    expect(projection.env.GANTRY_CHAT_JID).toBe('tg:group');
    expect(projection.env.GANTRY_PARENT_TASK_ID).toBe('task_parent');
    expect(projection.env.GANTRY_LIVE_STOP_ACTION_TOKEN).toBe('stop-token-1');
    expect(JSON.parse(projection.env.GANTRY_MCP_TOOL_NAMES_JSON)).toEqual(
      projection.selectedToolNames,
    );
    // Browser IPC token never leaks when browser is not enabled.
    expect(projection.env.GANTRY_BROWSER_IPC_AUTH_TOKEN).toBeUndefined();
  });

  it('mounts browser gateway tools only when browser IPC is enabled AND Browser is selected', () => {
    const projection = buildGantryMcpProjection({
      configuredAllowedTools: ['Browser'],
      hideAuthorityTools: false,
      processEnv: {
        ...BASE_ENV,
        GANTRY_BROWSER_IPC_AUTH_TOKEN: 'browser-token',
      },
    });
    expect(projection.browserIpcEnabled).toBe(true);
    expect(projection.selectedToolNames).toContain('browser_open');
    expect(projection.selectedToolNames).toContain('browser_status');
    expect(projection.env.GANTRY_BROWSER_IPC_AUTH_TOKEN).toBe('browser-token');
  });

  it('does not enable browser tools when Browser is selected but the host did not provide the browser IPC token', () => {
    const projection = buildGantryMcpProjection({
      configuredAllowedTools: ['Browser'],
      hideAuthorityTools: false,
      processEnv: BASE_ENV,
    });
    expect(projection.browserIpcEnabled).toBe(false);
    expect(projection.selectedToolNames).not.toContain('browser_open');
    expect(projection.env.GANTRY_BROWSER_IPC_AUTH_TOKEN).toBeUndefined();
  });

  it('drops authority-changing request tools when hideAuthorityTools is set', () => {
    const open = buildGantryMcpProjection({
      configuredAllowedTools: [],
      hideAuthorityTools: false,
      processEnv: BASE_ENV,
    });
    const hidden = buildGantryMcpProjection({
      configuredAllowedTools: [],
      hideAuthorityTools: true,
      processEnv: BASE_ENV,
    });
    expect(open.selectedToolNames).toContain('request_access');
    expect(hidden.selectedToolNames).not.toContain('request_access');
    expect(hidden.selectedToolNames).not.toContain('request_mcp_server');
  });
});
