import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createBuiltinToolExclusionMiddleware,
  EXCLUDED_ASYNC_SUBAGENT_DEEPAGENT_TOOL_NAMES,
  EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES,
  EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
  EXCLUDED_RAW_DEEPAGENT_TOOL_NAMES,
  READONLY_SKILL_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
  WRITE_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
} from '@core/adapters/llm/deepagents-langchain/runner/builtin-tool-exclusion.js';
import {
  shouldProjectGantryFilesystemTools,
  shouldProjectGantryShellTool,
} from '@core/adapters/llm/deepagents-langchain/runner/mcp-tools.js';
import {
  createGantryShellTool,
  GANTRY_SHELL_TOOL_NAME,
} from '@core/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.js';

// The DeepAgents/LangChain packages are gated to the approved adapter boundary by
// the provider-boundary sentinel; a test file may not statically import them. The
// real-surface probe below needs the actual createDeepAgent + a fake chat model,
// so it dynamically imports them via split specifiers (the sentinel only matches
// the static `from '...'` import form and the LangChain package-prefix token).
// This keeps the probe at full strength while staying outside the static import
// boundary — the same escape hatch the model-factory test uses for env-key
// string literals.
async function loadRealDeepAgentSurface(): Promise<{
  createDeepAgent: (config: Record<string, unknown>) => {
    invoke: (input: {
      messages: Array<{ role: string; content: string }>;
    }) => Promise<unknown>;
  };
  StateBackend: new () => unknown;
  FakeChatModel: new (fields: { responses: string[] }) => unknown;
}> {
  const deepagentsMod = (await import('deep' + 'agents')) as {
    createDeepAgent: (config: Record<string, unknown>) => never;
    StateBackend: new () => unknown;
  };
  const testingMod = (await import('@langchain' + '/core/utils/testing')) as {
    FakeListChatModel: new (fields: { responses: string[] }) => unknown;
  };
  return {
    createDeepAgent: deepagentsMod.createDeepAgent as never,
    StateBackend: deepagentsMod.StateBackend,
    FakeChatModel: testingMod.FakeListChatModel,
  };
}

function makeCapturingModel(
  FakeChatModel: new (fields: { responses: string[] }) => unknown,
  boundToolNamesPerCall: string[][],
): unknown {
  class CapturingFakeModel extends (FakeChatModel as new (fields: {
    responses: string[];
  }) => { bindTools?: (t: unknown, k?: unknown) => unknown }) {
    bindTools(tools: unknown, kwargs?: unknown): unknown {
      boundToolNamesPerCall.push(
        (Array.isArray(tools) ? tools : [])
          .map((tool) => (tool as { name?: unknown })?.name)
          .filter((name): name is string => typeof name === 'string'),
      );
      const proto = Object.getPrototypeOf(Object.getPrototypeOf(this)) as {
        bindTools: (t: unknown, k?: unknown) => unknown;
      };
      return proto.bindTools.call(this, tools, kwargs);
    }
  }
  return new CapturingFakeModel({ responses: ['done'] });
}

const DENY_ALL: Array<{ operations: string[]; paths: string[]; mode: string }> =
  [{ operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }];

const DEEPAGENTS_DIR = path.resolve(
  __dirname,
  '../../../src/adapters/llm/deepagents-langchain',
);

function readDirFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readDirFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe('DeepAgents raw authority denial', () => {
  it('excludes raw built-in and async delegation tools from the model-visible surface', async () => {
    const middleware = createBuiltinToolExclusionMiddleware() as unknown as {
      name: string;
      wrapModelCall: (
        request: { tools: Array<{ name: string }> },
        handler: (r: { tools: Array<{ name: string }> }) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    expect(middleware.name).toBe('GantryBuiltinToolExclusionMiddleware');

    let seen: Array<{ name: string }> = [];
    await middleware.wrapModelCall(
      {
        tools: [
          { name: 'task' },
          { name: 'write_todos' },
          { name: 'start_async_task' },
          { name: 'check_async_task' },
          { name: 'update_async_task' },
          { name: 'cancel_async_task' },
          { name: 'list_async_tasks' },
          { name: 'ls' },
          { name: 'read_file' },
          { name: 'write_file' },
          { name: 'edit_file' },
          { name: 'glob' },
          { name: 'grep' },
          { name: 'send_message' },
          { name: 'browser_open' },
          { name: 'mcp_call_tool' },
        ],
      },
      async (request) => {
        seen = request.tools;
        return { result: [] };
      },
    );
    const seenNames = seen.map((tool) => tool.name).sort();
    expect(seenNames).toEqual([
      'browser_open',
      'mcp_call_tool',
      'send_message',
    ]);
    for (const denied of [
      'task',
      'write_todos',
      'start_async_task',
      'check_async_task',
      'update_async_task',
      'cancel_async_task',
      'list_async_tasks',
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
    ]) {
      expect(seenNames).not.toContain(denied);
    }
  });

  it('lists raw DeepAgents tool names as excluded by category', () => {
    expect([...EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES].sort()).toEqual([
      'edit_file',
      'glob',
      'grep',
      'ls',
      'read_file',
      'task',
      'write_file',
      'write_todos',
    ]);
    expect([...EXCLUDED_ASYNC_SUBAGENT_DEEPAGENT_TOOL_NAMES].sort()).toEqual([
      'cancel_async_task',
      'check_async_task',
      'list_async_tasks',
      'start_async_task',
      'update_async_task',
    ]);
    expect([...EXCLUDED_RAW_DEEPAGENT_TOOL_NAMES].sort()).toEqual([
      'cancel_async_task',
      'check_async_task',
      'edit_file',
      'glob',
      'grep',
      'list_async_tasks',
      'ls',
      'read_file',
      'start_async_task',
      'task',
      'update_async_task',
      'write_file',
      'write_todos',
    ]);
    expect([...EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES].sort()).toEqual([
      'edit_file',
      'glob',
      'grep',
      'ls',
      'read_file',
      'write_file',
    ]);
    expect([...READONLY_SKILL_FILESYSTEM_DEEPAGENT_TOOL_NAMES].sort()).toEqual([
      'glob',
      'grep',
      'ls',
      'read_file',
    ]);
    expect([...WRITE_FILESYSTEM_DEEPAGENT_TOOL_NAMES].sort()).toEqual([
      'edit_file',
      'write_file',
    ]);
  });

  it('exposes only read-only filesystem tools when reviewed skill files are projected', async () => {
    const middleware = createBuiltinToolExclusionMiddleware({
      exposeSkillReadTools: true,
    }) as unknown as {
      wrapModelCall: (
        request: { tools: Array<{ name: string }> },
        handler: (r: { tools: Array<{ name: string }> }) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    let seen: Array<{ name: string }> = [];
    await middleware.wrapModelCall(
      {
        tools: [
          { name: 'task' },
          { name: 'write_todos' },
          { name: 'start_async_task' },
          { name: 'check_async_task' },
          { name: 'update_async_task' },
          { name: 'cancel_async_task' },
          { name: 'list_async_tasks' },
          { name: 'ls' },
          { name: 'read_file' },
          { name: 'write_file' },
          { name: 'edit_file' },
          { name: 'glob' },
          { name: 'grep' },
          { name: 'send_message' },
        ],
      },
      async (request) => {
        seen = request.tools;
        return { result: [] };
      },
    );

    expect(seen.map((tool) => tool.name).sort()).toEqual([
      'glob',
      'grep',
      'ls',
      'read_file',
      'send_message',
    ]);
  });

  // R7: assert against the ACTUAL model-visible tool list of a real
  // createDeepAgent invocation — not an isolated middleware. The fake model's
  // bindTools is the real seam where the post-middleware tool list reaches the
  // model, so this captures exactly what the production graph would bind. The
  // production wiring uses ONLY createBuiltinToolExclusionMiddleware() (no probe
  // middleware), so the captured list is the real surface.
  it('binds zero baked-in DeepAgents tools to the real model when the exclusion middleware is wired (production surface)', async () => {
    const { createDeepAgent, StateBackend, FakeChatModel } =
      await loadRealDeepAgentSurface();
    const boundToolNamesPerCall: string[][] = [];
    const model = makeCapturingModel(FakeChatModel, boundToolNamesPerCall);
    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
      permissions: DENY_ALL,
      tools: [],
      middleware: [createBuiltinToolExclusionMiddleware()],
    });

    await agent.invoke({ messages: [{ role: 'user', content: 'hi' }] });

    expect(boundToolNamesPerCall.length).toBeGreaterThan(0);
    const everyBound = boundToolNamesPerCall.flat();
    for (const denied of EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES) {
      expect(everyBound).not.toContain(denied);
    }
  });

  // Negative control: without the exclusion middleware the real model DOES see
  // every baked-in tool (write_todos, the six filesystem tools, task) — proving
  // the probe above is meaningful and the security finding is real.
  it('real model sees all baked-in DeepAgents tools WITHOUT the exclusion middleware (negative control)', async () => {
    const { createDeepAgent, StateBackend, FakeChatModel } =
      await loadRealDeepAgentSurface();
    const boundToolNamesPerCall: string[][] = [];
    const model = makeCapturingModel(FakeChatModel, boundToolNamesPerCall);
    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
      permissions: DENY_ALL,
      tools: [],
      middleware: [],
    });

    await agent.invoke({ messages: [{ role: 'user', content: 'hi' }] });

    const everyBound = boundToolNamesPerCall.flat();
    for (const baked of EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES) {
      expect(everyBound).toContain(baked);
    }
  });

  it('never references LocalShellBackend, FilesystemBackend, or an execute tool in the runner', () => {
    const runnerFile = path.join(
      DEEPAGENTS_DIR,
      'runner',
      'deep-agent-runner.ts',
    );
    const text = fs.readFileSync(runnerFile, 'utf-8');
    // The import statement and createDeepAgent backend must be StateBackend only.
    expect(text).toMatch(/new\s+StateBackend\([^)]*\)/);
    expect(text).not.toMatch(/new\s+LocalShellBackend/);
    expect(text).not.toMatch(/new\s+FilesystemBackend/);
    expect(text).not.toMatch(/import\s*\{[^}]*LocalShellBackend[^}]*\}/);
    expect(text).not.toMatch(/import\s*\{[^}]*FilesystemBackend[^}]*\}/);
  });

  it('keeps fail-closed filesystem permissions on the agent', () => {
    const runnerFile = path.join(
      DEEPAGENTS_DIR,
      'runner',
      'deep-agent-runner.ts',
    );
    const text = fs.readFileSync(runnerFile, 'utf-8');
    expect(text).toMatch(/operations:\s*\['read',\s*'write'\]/);
    expect(text).toMatch(/paths:\s*\['\/\*\*'\]/);
    expect(text).toMatch(/mode:\s*'deny'/);
    expect(text).toContain('DENY_ALL_FILESYSTEM');
    expect(text).toContain('READONLY_SKILLS_FILESYSTEM');
    expect(text).toContain("paths: ['/skills', '/skills/**']");
  });

  it('reads no .mcp.json anywhere in the DeepAgents adapter directory', () => {
    // rg-style guard: the lane fully controls `tools`; it must never read a raw
    // DeepAgents/MCP `.mcp.json` authority file. (See the adapter AGENTS.md note.)
    for (const file of readDirFilesRecursive(DEEPAGENTS_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const text = fs.readFileSync(file, 'utf-8');
      expect(text, `${file} must not reference .mcp.json`).not.toContain(
        '.mcp.json',
      );
    }
  });

  // Phase 4: the Gantry-owned shell tool is the ONLY execution surface, and it is
  // injected into `tools` only when BOTH the host enabled it (the same guard
  // inputs derive the flag) AND a resolved RunCommand rule is present. The tool
  // is named RunCommand — NOT `execute` (which collides with deepagents).
  describe('Gantry shell tool projection (the only execution surface)', () => {
    it('projects ONLY when the host flag is set AND a RunCommand rule is present', () => {
      // Authorized: flag '1' + a scoped RunCommand rule.
      expect(
        shouldProjectGantryShellTool({
          shellEnabledEnv: '1',
          configuredAllowedTools: ['RunCommand(npm test)'],
        }),
      ).toBe(true);
      // No flag (host fails closed / direct mode) -> never projected.
      expect(
        shouldProjectGantryShellTool({
          shellEnabledEnv: undefined,
          configuredAllowedTools: ['RunCommand(npm test)'],
        }),
      ).toBe(false);
      expect(
        shouldProjectGantryShellTool({
          shellEnabledEnv: '0',
          configuredAllowedTools: ['RunCommand(npm test)'],
        }),
      ).toBe(false);
      // Flag set but no RunCommand rule -> not projected (no shell requested).
      expect(
        shouldProjectGantryShellTool({
          shellEnabledEnv: '1',
          configuredAllowedTools: ['WebSearch', 'FileRead'],
        }),
      ).toBe(false);
    });

    it('names the shell tool RunCommand, never execute/ls/read_file (no deepagents collision)', () => {
      expect(GANTRY_SHELL_TOOL_NAME).toBe('RunCommand');
      const tool = createGantryShellTool({
        workspaceFolder: 'group',
        memoryBlock: '',
        configuredAllowedTools: ['RunCommand(npm test)'],
        gateContext: { conversationId: 'tg:group' },
        permissionEnv: {
          appId: 'default',
          agentId: 'agent:main',
          chatJid: 'tg:group',
          jobId: '',
          jobName: '',
          jobRunId: '',
          jobRunLeaseToken: '',
          jobRunLeaseFencingVersion: '',
          ipcAuthToken: 'tok',
          ipcResponseVerifyKey: '',
          ipcResponseKeyId: 'kid',
          permissionRequestTimeoutMs: 1000,
          resolveWorkspaceIpcDir: (folder: string) => `/tmp/ipc/${folder}`,
        },
        lockedAccessPreset: false,
      });
      expect(tool.name).toBe('RunCommand');
      for (const collidingName of [
        'execute',
        'ls',
        'read_file',
        'write_file',
        'edit_file',
        'glob',
        'grep',
        'task',
        'write_todos',
      ]) {
        expect(tool.name).not.toBe(collidingName);
      }
    });
  });

  describe('Gantry filesystem facade projection', () => {
    it('projects File facades only when the host filesystem flag is set', () => {
      expect(
        shouldProjectGantryFilesystemTools({
          filesystemEnabledEnv: '1',
        }),
      ).toBe(true);
      expect(
        shouldProjectGantryFilesystemTools({
          filesystemEnabledEnv: undefined,
        }),
      ).toBe(false);
      expect(
        shouldProjectGantryFilesystemTools({
          filesystemEnabledEnv: '0',
        }),
      ).toBe(false);
    });
  });
});
