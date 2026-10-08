import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import '@core/channels/register-builtins.js';
import { compileSpawnSystemPrompt } from '@core/runtime/agent-spawn-prompt.js';
import { prepareWorkerAuthorityProjection } from '@core/runtime/agent-spawn-preparation.js';
import { composeAgentCapabilities } from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import { buildGantryMcpProjection } from '@core/adapters/llm/deepagents-langchain/runner/gantry-mcp-env.js';
import { composeDeepAgentSystemPrompt } from '@core/adapters/llm/deepagents-langchain/runner/system-prompt.js';
import {
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
} from '@core/shared/agent-engine.js';

async function registeredTools(
  env: Record<string, string>,
): Promise<Set<string>> {
  const { effectiveEnabledMcpToolNames } =
    await import('@core/runner/mcp/server.js');
  return effectiveEnabledMcpToolNames(
    env.GANTRY_MCP_TOOL_NAMES_JSON,
    env.GANTRY_ADMIN_MCP_TOOLS_JSON,
    env.GANTRY_NO_PERMISSION_TOOLS ?? '',
    env.GANTRY_AGENT_ACCESS_PRESET === 'locked',
    env.GANTRY_ASYNC_TASK_TOOLS_ENABLED ?? '',
    env.GANTRY_CHAT_JID,
    env.GANTRY_PERMISSION_LANE,
  );
}

function advertisedTools(prompt: string): Set<string> {
  const section = prompt.split('## Gantry tools in this run')[1];
  expect(section).toBeDefined();
  const names = section?.match(/^Available: (.+)\.$/m)?.[1];
  expect(names).toBeDefined();
  return new Set(names?.split(', '));
}

describe('the-agent-can-t-tell-which-gantry-tools', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      name: 'delegation is granted',
      tools: ['AgentDelegation'],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: false,
      reason: undefined,
      delegation: true,
    },
    {
      name: 'delegation has no grant',
      tools: [],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: false,
      reason: 'AgentDelegation has not been granted',
      delegation: false,
    },
    {
      name: 'the access preset is locked',
      tools: ['AgentDelegation', 'mcp__gantry__service_restart'],
      accessPreset: 'locked' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: false,
      reason: 'locked access preset',
      delegation: false,
    },
    {
      name: 'authority tools are hidden while selected admin tools remain',
      tools: ['AgentDelegation', 'mcp__gantry__service_restart'],
      accessPreset: 'full' as const,
      hidden: true,
      asyncEnabled: true,
      autonomous: false,
      reason: 'tools are hidden for this run',
      delegation: false,
    },
    {
      name: 'the async executor is unavailable',
      tools: ['AgentDelegation'],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: false,
      autonomous: false,
      reason: 'async task executor is unavailable',
      delegation: false,
    },
    {
      name: 'an autonomous run has no browser IPC credential',
      tools: ['Browser', 'mcp__gantry__scheduler_run_now'],
      accessPreset: 'full' as const,
      hidden: false,
      asyncEnabled: true,
      autonomous: true,
      reason: 'AgentDelegation has not been granted',
      delegation: false,
    },
  ])('advertises the mounted surface when $name', async (scenario) => {
    vi.stubEnv('GANTRY_NO_PERMISSION_TOOLS', '0');
    vi.stubEnv('GANTRY_IPC_DIR', tmpdir());
    const agentInput = {
      prompt: 'Which Gantry tools can I use in this run?',
      workspaceFolder: 'team',
      chatJid: 'tg:1001',
      toolPolicyRules: scenario.tools,
      hideAuthorityTools: scenario.hidden,
      isScheduledJob: scenario.autonomous,
    };
    const authority = await prepareWorkerAuthorityProjection({
      agentInput,
      accessPreset: scenario.accessPreset,
      delegates: [],
      getConversationBoundAgentIds: () => new Set(),
      personasByAgentId: {},
      workspaceFolder: agentInput.workspaceFolder,
      options: { asyncTaskRepositoryAvailable: scenario.asyncEnabled },
      getAgentRepository: () => {
        throw new Error('No delegate lookup is needed for this run');
      },
      warn: () => {},
    });
    const claude = composeAgentCapabilities({
      mcpServerPath: join(tmpdir(), 'gantry-mcp-stdio.js'),
      ...agentInput,
      configuredAllowedTools: scenario.tools,
      accessPreset: authority.accessPreset,
      hideAuthorityTools: authority.hideAuthorityTools,
      asyncTaskToolsEnabled: scenario.asyncEnabled,
    });
    const claudeEnv = claude.mcpServers.gantry.env ?? {};
    const deep = buildGantryMcpProjection({
      configuredAllowedTools: scenario.tools,
      hideAuthorityTools: authority.hideAuthorityTools,
      processEnv: {
        GANTRY_CHAT_JID: agentInput.chatJid,
        GANTRY_AGENT_ACCESS_PRESET: authority.accessPreset,
        GANTRY_NO_PERMISSION_TOOLS: authority.hideAuthorityTools ? '1' : '',
        GANTRY_ASYNC_TASK_TOOLS_ENABLED: scenario.asyncEnabled ? '1' : '',
        GANTRY_PERMISSION_LANE: scenario.autonomous
          ? 'autonomous'
          : 'interactive',
      },
    });
    const mounted = await registeredTools({
      ...claudeEnv,
      GANTRY_AGENT_ACCESS_PRESET: authority.accessPreset,
    });
    expect(claude.mcpServers.gantry.alwaysLoad).toBe(true);
    expect(await registeredTools(deep.env)).toEqual(mounted);
    expect(new Set(deep.selectedToolNames)).toEqual(mounted);
    expect(mounted.has('delegate_task')).toBe(scenario.delegation);
    expect(mounted.has('task_message')).toBe(scenario.delegation);
    if (scenario.delegation) {
      for (const name of ['task_get', 'task_list', 'task_cancel']) {
        expect(mounted.has(name)).toBe(true);
      }
    }
    expect(mounted.has('send_message')).toBe(true);
    if (scenario.accessPreset === 'locked') {
      expect(mounted.has('request_access')).toBe(false);
      expect(mounted.has('service_restart')).toBe(false);
    } else if (scenario.hidden) {
      expect(mounted.has('request_access')).toBe(true);
      expect(mounted.has('service_restart')).toBe(true);
    }
    if (scenario.autonomous) {
      expect(mounted.has('scheduler_run_now')).toBe(false);
      expect(mounted.has('browser_open')).toBe(false);
    }
    for (const agentEngine of [DEFAULT_AGENT_ENGINE, DEEPAGENTS_ENGINE]) {
      const compiled = await compileSpawnSystemPrompt({
        group: {
          name: 'Team',
          folder: 'team',
          trigger: '',
          added_at: '2026-01-01T00:00:00.000Z',
          conversationKind: 'dm',
        },
        agentInput,
        appId: 'default',
        accessPreset: authority.accessPreset,
        mcpInventoryToolsMounted: !authority.hideAuthorityTools,
        agentEngine,
        gantryToolSelection: {
          ...authority.gantryToolSelection,
          browserIpcEnabled: false,
        },
        fileArtifactStore: () => undefined,
        measureAsync: (_name, fn) => fn(),
      });
      const prompt =
        agentEngine === DEEPAGENTS_ENGINE
          ? (composeDeepAgentSystemPrompt({
              ...agentInput,
              allowedTools: scenario.tools,
              permissionMode: 'ask',
              compiledSystemPrompt: compiled,
            }) ?? '')
          : compiled;
      expect(advertisedTools(prompt)).toEqual(mounted);
      if (scenario.reason) {
        const delegationLine = prompt
          .split('\n')
          .find(
            (line) =>
              line.startsWith('Unavailable: ') &&
              line.includes('delegate_task'),
          );
        expect(delegationLine).toContain(scenario.reason);
      }
    }
  });
});
