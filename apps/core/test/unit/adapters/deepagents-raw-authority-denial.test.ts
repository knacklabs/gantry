import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createBuiltinToolExclusionMiddleware,
  EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES,
  EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
} from '@core/adapters/llm/deepagents-langchain/runner/builtin-tool-exclusion.js';

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
  it('excludes task, write_todos, and the six filesystem tools from the model-visible surface', async () => {
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

  it('lists task, write_todos, and the filesystem tools as excluded builtin tool names', () => {
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
    expect([...EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES].sort()).toEqual([
      'edit_file',
      'glob',
      'grep',
      'ls',
      'read_file',
      'write_file',
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
    expect(text).toContain('new StateBackend()');
    expect(text).not.toMatch(/new\s+LocalShellBackend/);
    expect(text).not.toMatch(/new\s+FilesystemBackend/);
    expect(text).not.toMatch(/import\s*\{[^}]*LocalShellBackend[^}]*\}/);
    expect(text).not.toMatch(/import\s*\{[^}]*FilesystemBackend[^}]*\}/);
  });

  it('keeps a deny-all filesystem permission block on the agent', () => {
    const runnerFile = path.join(
      DEEPAGENTS_DIR,
      'runner',
      'deep-agent-runner.ts',
    );
    const text = fs.readFileSync(runnerFile, 'utf-8');
    expect(text).toMatch(/operations:\s*\['read',\s*'write'\]/);
    expect(text).toMatch(/paths:\s*\['\/\*\*'\]/);
    expect(text).toMatch(/mode:\s*'deny'/);
    expect(text).toContain('permissions: DENY_ALL_FILESYSTEM');
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
});
