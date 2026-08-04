import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { composeAgentCapabilities } from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import { buildGantryMcpProjection } from '@core/adapters/llm/deepagents-langchain/runner/gantry-mcp-env.js';
import { startDeepAgentJobHeartbeat } from '@core/adapters/llm/deepagents-langchain/runner/job-heartbeat.js';
import { permissionRequestToolName } from '@core/adapters/llm/anthropic-claude-agent/runner/permission-suggestions.js';
import type { DeepAgentRunnerInput } from '@core/adapters/llm/deepagents-langchain/runner/types.js';
import {
  callableAgentToolName,
  projectCallableAgentTools,
} from '@core/application/core-tools/callable-agent-tools.js';
import type { RunnerOutputFrame } from '@core/runner/runner-frame.js';

const CALLABLE_AGENT_MANIFEST = projectCallableAgentTools({
  agents: [
    {
      id: 'agent:caller',
      appId: 'default',
      name: 'Caller',
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
  callerAgentId: 'agent:caller',
  callerFolder: 'caller',
  delegates: ['reviewer'],
  conversationBoundAgentIds: new Set(['agent:reviewer']),
  toolPolicyRules: ['AgentDelegation'],
});
const SYNTHETIC_TOOL_NAME = callableAgentToolName(CALLABLE_AGENT_MANIFEST[0]!);
const FULL_SYNTHETIC_TOOL_NAME = `mcp__gantry__${SYNTHETIC_TOOL_NAME}`;
const ENV_KEYS = [
  'GANTRY_IPC_DIR',
  'GANTRY_MCP_TOOL_NAMES_JSON',
  'GANTRY_ADMIN_MCP_TOOLS_JSON',
  'GANTRY_NO_PERMISSION_TOOLS',
  'GANTRY_AGENT_ACCESS_PRESET',
  'GANTRY_ASYNC_TASK_TOOLS_ENABLED',
  'GANTRY_PARENT_TASK_ID',
  'GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON',
  'GANTRY_CALLABLE_AGENT_MANIFEST_JSON',
] as const;
const previousEnv = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

let ipcDir: string;

beforeEach(() => {
  vi.resetModules();
  ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'callable-agent-lanes-'));
  process.env.GANTRY_IPC_DIR = ipcDir;
  process.env.GANTRY_MCP_TOOL_NAMES_JSON = '[]';
  process.env.GANTRY_ADMIN_MCP_TOOLS_JSON = '[]';
  process.env.GANTRY_AGENT_ACCESS_PRESET = 'full';
  process.env.GANTRY_ASYNC_TASK_TOOLS_ENABLED = '1';
  process.env.GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON = JSON.stringify([
    'AgentDelegation',
  ]);
  process.env.GANTRY_CALLABLE_AGENT_MANIFEST_JSON = JSON.stringify(
    CALLABLE_AGENT_MANIFEST,
  );
  delete process.env.GANTRY_NO_PERMISSION_TOOLS;
  delete process.env.GANTRY_PARENT_TASK_ID;
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  fs.rmSync(ipcDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('callable-agent projection lanes', () => {
  it('projects the same synthetic tool into Anthropic, DeepAgents, and stdio MCP', async () => {
    const anthropic = anthropicProjection();
    const deepAgents = deepAgentsProjection();
    const stdio = await stdioProjection();

    expect(anthropic.allowedTools).toContain(FULL_SYNTHETIC_TOOL_NAME);
    expect(deepAgents.selectedToolNames).toContain(SYNTHETIC_TOOL_NAME);
    expect(stdio).toContain(SYNTHETIC_TOOL_NAME);
  });

  it.each([
    ['delegated child', { parentTaskId: 'task_parent' }],
    ['locked mode', { locked: true }],
    ['empty allowlist', { emptyManifest: true }],
  ] as const)(
    'suppresses synthetic tools for %s in all three lanes',
    async (_name, suppression) => {
      const manifest = suppression.emptyManifest ? [] : CALLABLE_AGENT_MANIFEST;
      const anthropic = anthropicProjection({
        manifest,
        parentTaskId: suppression.parentTaskId,
        locked: suppression.locked,
      });
      const deepAgents = deepAgentsProjection({
        manifest,
        parentTaskId: suppression.parentTaskId,
        locked: suppression.locked,
      });
      const stdio = await stdioProjection({
        manifest,
        parentTaskId: suppression.parentTaskId,
        locked: suppression.locked,
      });

      expect(anthropic.allowedTools).not.toContain(FULL_SYNTHETIC_TOOL_NAME);
      expect(deepAgents.selectedToolNames).not.toContain(SYNTHETIC_TOOL_NAME);
      expect(stdio).not.toContain(SYNTHETIC_TOOL_NAME);
    },
  );

  it('canonicalizes synthetic tool activity to AgentDelegation runtime events', () => {
    vi.useFakeTimers();
    const frames: RunnerOutputFrame[] = [];
    const heartbeat = startDeepAgentJobHeartbeat({
      agentInput: {
        prompt: 'delegate review',
        appId: 'default',
        agentId: 'agent:caller',
        workspaceFolder: 'caller',
        chatJid: 'chat:1',
        isScheduledJob: true,
        jobId: 'job:1',
        runId: 'run:1',
        callableAgentManifest: CALLABLE_AGENT_MANIFEST,
      } satisfies DeepAgentRunnerInput,
      writeFrame: (frame) => frames.push(frame),
      getSessionId: () => undefined,
    });

    heartbeat.recordToolActivity(FULL_SYNTHETIC_TOOL_NAME);
    vi.advanceTimersByTime(15_000);
    heartbeat.stop();

    const payload = frames[0].runtimeEvents?.[0]?.payload as Record<
      string,
      unknown
    >;
    expect(payload.currentTool).toBe('AgentDelegation');
    expect(payload.lastTool).toBe('AgentDelegation');
    expect(permissionRequestToolName(FULL_SYNTHETIC_TOOL_NAME)).toBe(
      'AgentDelegation',
    );
    expect(permissionRequestToolName('mcp__gantry__send_message')).toBe(
      'mcp__gantry__send_message',
    );
  });
});

function anthropicProjection(
  input: {
    manifest?: typeof CALLABLE_AGENT_MANIFEST | [];
    parentTaskId?: string;
    locked?: boolean;
  } = {},
) {
  return composeAgentCapabilities({
    mcpServerPath: '/tmp/ipc-mcp-stdio.js',
    chatJid: 'chat:1',
    workspaceFolder: 'caller',
    configuredAllowedTools: ['AgentDelegation'],
    callableAgentManifest: input.manifest ?? CALLABLE_AGENT_MANIFEST,
    asyncTaskToolsEnabled: true,
    accessPreset: input.locked ? 'locked' : 'full',
    parentTaskId: input.parentTaskId,
  });
}

function deepAgentsProjection(
  input: {
    manifest?: typeof CALLABLE_AGENT_MANIFEST | [];
    parentTaskId?: string;
    locked?: boolean;
  } = {},
) {
  return buildGantryMcpProjection({
    configuredAllowedTools: ['AgentDelegation'],
    hideAuthorityTools: false,
    callableAgentManifest: input.manifest ?? CALLABLE_AGENT_MANIFEST,
    processEnv: {
      GANTRY_ASYNC_TASK_TOOLS_ENABLED: '1',
      GANTRY_AGENT_ACCESS_PRESET: input.locked ? 'locked' : 'full',
      GANTRY_PARENT_TASK_ID: input.parentTaskId,
    },
  });
}

async function stdioProjection(
  input: {
    manifest?: typeof CALLABLE_AGENT_MANIFEST | [];
    parentTaskId?: string;
    locked?: boolean;
  } = {},
): Promise<string[]> {
  process.env.GANTRY_CALLABLE_AGENT_MANIFEST_JSON = JSON.stringify(
    input.manifest ?? CALLABLE_AGENT_MANIFEST,
  );
  process.env.GANTRY_AGENT_ACCESS_PRESET = input.locked ? 'locked' : 'full';
  if (input.parentTaskId) {
    process.env.GANTRY_PARENT_TASK_ID = input.parentTaskId;
  } else {
    delete process.env.GANTRY_PARENT_TASK_ID;
  }
  vi.resetModules();
  const { createGantryMcpServer } = await import('@core/runner/mcp/server.js');
  const server = createGantryMcpServer() as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(server._registeredTools);
}
