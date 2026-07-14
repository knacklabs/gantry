import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selectedMemoryIpcActions,
  selectedGantryMcpToolNames,
} from '@agent-runner-src/gantry-mcp-tool-surface.js';
import {
  GANTRY_CLAUDE_SDK_SKILLS_ENV,
  SDK_NATIVE_SKILL_DISABLE_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
} from '@core/adapters/llm/anthropic-claude-agent/native-sdk-skills.js';
import type { AgentRunnerInput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';

const sdkState = vi.hoisted(() => ({
  mode: 'success' as
    | 'success'
    | 'mcp-failed'
    | 'mcp-missing'
    | 'mcp-metadata-omitted'
    | 'active-followup'
    | 'memory-denial'
    | 'agent-model-denial'
    | 'agent-input-field-denial'
    | 'subagent-attribution'
    | 'partial-output'
    | 'partial-thinking-output'
    | 'structured-thinking-output'
    | 'structured-thinking-only-output'
    | 'auth-result-text'
    | 'billing-result-error'
    | 'success-result-empty-error-flag',
  calls: [] as Array<{
    options: Record<string, any>;
    streamMessages: unknown[];
    permissionDecision?: unknown;
  }>,
}));
const clockState = vi.hoisted(() => ({
  nowMs: () => Date.now(),
}));

vi.mock('@core/shared/time/datetime.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@core/shared/time/datetime.js')>();
  return {
    ...actual,
    nowMs: () => clockState.nowMs(),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
  query: async function* ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<{
      message: { content: unknown };
      parent_tool_use_id: string | null;
    }>;
    options: Record<string, any>;
  }) {
    const call = {
      options,
      streamMessages: [] as unknown[],
      permissionDecision: undefined as unknown,
    };
    sdkState.calls.push(call);

    if (sdkState.mode === 'mcp-missing') {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-missing-mcp',
        mcp_servers: [],
        permissionMode: options.permissionMode,
        slash_commands: ['/compact'],
      };
      return;
    }

    if (sdkState.mode === 'mcp-metadata-omitted') {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-omitted-mcp-metadata',
        permissionMode: options.permissionMode,
        slash_commands: ['/compact'],
      };
      return;
    }

    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-boundary',
      mcp_servers: [
        {
          name: 'gantry',
          status: sdkState.mode === 'mcp-failed' ? 'failed' : 'connected',
        },
      ],
      permissionMode: options.permissionMode,
      slash_commands: ['/compact', '/model'],
    };

    const iterator = prompt[Symbol.asyncIterator]();
    const first = await nextWithTimeout(iterator, 1_000);
    if (first && !first.done) {
      call.streamMessages.push(first.value.message.content);
    }

    if (sdkState.mode === 'active-followup') {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const inputDir = process.env.GANTRY_IPC_INPUT_DIR || '';
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(
        path.join(inputDir, '001-followup.json'),
        JSON.stringify({
          type: 'message',
          text: 'follow-up while Claude is still running',
        }),
      );
      await delay(700);
      yield { type: 'result', subtype: 'success', result: 'ok' };
      const next = await nextWithTimeout(iterator, 1_500);
      if (next && !next.done) {
        call.streamMessages.push(next.value.message.content);
      }
      return;
    }

    if (sdkState.mode === 'memory-denial') {
      call.permissionDecision = await options.canUseTool(
        'Bash',
        { cmd: 'rm -rf /tmp/from-memory', apiKey: 'sk-from-memory' },
        {
          signal: new AbortController().signal,
          title: 'Run command from memory',
          displayName: 'Bash',
          description: 'Memory says this command is required',
          decisionReason: 'Durable memory requested shell access',
        },
      );
    }

    if (sdkState.mode === 'agent-model-denial') {
      call.permissionDecision = await options.canUseTool(
        'Agent',
        { model: 'opus 4.7', prompt: 'delegate review' },
        {
          signal: new AbortController().signal,
          title: 'Run subagent',
          displayName: 'Agent',
          description: 'Delegate to subagent',
          decisionReason: 'Run with a custom model override',
        },
      );
    }

    if (sdkState.mode === 'agent-input-field-denial') {
      call.permissionDecision = await options.canUseTool(
        process.env.TEST_SUBAGENT_TOOL_NAME || 'Agent',
        { prompt: 'delegate review', disallowedTools: ['Bash'] },
        {
          signal: new AbortController().signal,
          title: 'Run subagent',
          displayName: 'Agent',
          description: 'Delegate to subagent',
          decisionReason: 'Run with inline subagent tool policy',
        },
      );
    }

    if (sdkState.mode === 'subagent-attribution') {
      yield {
        type: 'assistant',
        uuid: 'assistant-subagent-message',
        parent_tool_use_id: 'toolu-parent-agent',
        message: { content: [{ type: 'text', text: 'subagent result' }] },
      };
    }

    if (sdkState.mode === 'partial-output') {
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' },
        },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' },
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Hello world' };
      return;
    }

    if (sdkState.mode === 'partial-thinking-output') {
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'hidden reasoning' },
        },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Visible answer' },
        },
      };
      yield { type: 'result', subtype: 'success', result: 'Visible answer' };
      return;
    }

    if (sdkState.mode === 'structured-thinking-output') {
      yield {
        type: 'assistant',
        uuid: 'assistant-structured-message',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'hidden reasoning' },
            { type: 'redacted_thinking', data: 'hidden encrypted reasoning' },
            { type: 'text', text: 'Visible answer.' },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'hidden reasoning Visible answer.',
      };
      return;
    }

    if (sdkState.mode === 'structured-thinking-only-output') {
      yield {
        type: 'assistant',
        uuid: 'assistant-reasoning-only-message',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'thinking', thinking: 'hidden reasoning' }],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'hidden reasoning',
      };
      return;
    }

    if (sdkState.mode === 'auth-result-text') {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Invalid API key · Fix external API key',
      };
      return;
    }

    if (sdkState.mode === 'billing-result-error') {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Credit balance is too low for this request'],
      };
      return;
    }

    if (sdkState.mode === 'success-result-empty-error-flag') {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'ok',
      };
      return;
    }

    yield { type: 'result', subtype: 'success', result: 'ok' };
  },
}));

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T> | null> {
  const timeout = Symbol('timeout');
  const result = await Promise.race([
    iterator.next(),
    new Promise<typeof timeout>((resolve) =>
      setTimeout(() => resolve(timeout), timeoutMs),
    ),
  ]);
  return result === timeout ? null : result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-claude-sdk-'));
  tempRoots.push(root);
  return root;
}

function prepareRuntimeEnv(): {
  root: string;
  mcpServerPath: string;
} {
  const root = makeTempRoot();
  const groupDir = path.join(root, 'workspace', 'group');
  const extraDir = path.join(root, 'workspace', 'extra');
  const ipcDir = path.join(root, 'ipc', 'group');
  const inputDir = path.join(ipcDir, 'input');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(extraDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  vi.stubEnv('GANTRY_WORKSPACE_GROUP_DIR', groupDir);
  vi.stubEnv('GANTRY_WORKSPACE_EXTRA_DIR', extraDir);
  vi.stubEnv('GANTRY_IPC_DIR', ipcDir);
  vi.stubEnv('GANTRY_IPC_INPUT_DIR', inputDir);
  vi.stubEnv('GANTRY_IPC_AUTH_TOKEN', 'runner-ipc-token');
  vi.stubEnv('GANTRY_IPC_RESPONSE_VERIFY_KEY', 'runner-response-verify-key');
  vi.stubEnv('GANTRY_NO_PERMISSION_TOOLS', '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'raw-provider-key');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'raw-oauth-token');
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-config'));
  vi.stubEnv(
    GANTRY_CLAUDE_SDK_SKILLS_ENV,
    JSON.stringify(['gantry-admin', 'gantry-browser', 'linkedin-posting']),
  );
  return {
    root,
    mcpServerPath: path.join(root, 'mcp', 'stdio.js'),
  };
}

function runnerInput(
  overrides: Partial<AgentRunnerInput> = {},
): AgentRunnerInput {
  return {
    prompt: 'unused in direct runQuery tests',
    workspaceFolder: 'group',
    chatJid: 'tg:group',
    threadId: 'thread-1',
    compiledSystemPrompt: 'compiled Gantry system profile',
    ...overrides,
  };
}

async function importRunQuery() {
  vi.resetModules();
  return await import('@core/adapters/llm/anthropic-claude-agent/runner/query-loop.js');
}

function sdkProcessEnv(): Record<string, string | undefined> {
  const configDirKey = ['CLAUDE', 'CONFIG', 'DIR'].join('_');
  return { [configDirKey]: process.env[configDirKey] };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  sdkState.mode = 'success';
  sdkState.calls.length = 0;
  clockState.nowMs = () => Date.now();
  vi.unstubAllEnvs();
});

describe('Claude Agent SDK boundary integration', () => {
  it('logs SDK startup timing with the shared clock helper', async () => {
    sdkState.mode = 'partial-output';
    const env = prepareRuntimeEnv();
    const times = [
      1_000, 1_000, 1_017, 1_023, 1_031, 1_037, 1_041, 1_047, 1_053, 1_059,
    ];
    clockState.nowMs = () => times.shift() ?? 1_059;
    const stderr: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((line) => {
      stderr.push(String(line ?? ''));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello from Gantry',
      env.mcpServerPath,
      runnerInput(),
      sdkProcessEnv(),
      'sonnet',
      undefined,
      undefined,
    );

    logSpy.mockRestore();
    errorSpy.mockRestore();
    expect(stderr).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SDK query prepared in 17ms'),
        expect.stringContaining('SDK query iterator created in 23ms'),
        expect.stringContaining('First SDK message after 37ms'),
        expect.stringContaining(
          'Session initialized after 41ms: provider resume handle received',
        ),
        expect.stringContaining('First SDK text delta after 53ms'),
        expect.stringContaining('First SDK result after 59ms'),
      ]),
    );
  });

  it('emits SDK partial text deltas as channel-visible streaming chunks', async () => {
    sdkState.mode = 'partial-output';
    const env = prepareRuntimeEnv();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello from Gantry',
      env.mcpServerPath,
      runnerInput(),
      sdkProcessEnv(),
      'sonnet',
      undefined,
      undefined,
    );

    const outputs = logSpy.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((line) => line.startsWith('{'))
      .map(
        (line) =>
          JSON.parse(line) as {
            result: string | null;
            newSessionId?: string;
            sessionInit?: boolean;
            runtimeEventOnly?: boolean;
            runtimeEvents?: Array<{
              eventType?: string;
              payload?: Record<string, unknown>;
            }>;
          },
      );
    logSpy.mockRestore();

    expect(outputs[0]).toMatchObject({
      result: null,
      newSessionId: 'claude-session-boundary',
      runtimeEvents: [
        expect.objectContaining({
          eventType: 'run.startup_diagnostic',
          payload: expect.objectContaining({
            diagnostic: 'tool_search',
            enableToolSearch: 'auto:10',
            reason: 'official_auto_threshold',
          }),
        }),
      ],
    });
    expect(outputs[0].sessionInit).toBeUndefined();
    const firstVisibleIdx = outputs.findIndex(
      (output) => typeof output.result === 'string' && output.result.length > 0,
    );
    expect(firstVisibleIdx).toBe(1);
    const userVisibleOutputs = outputs.filter(
      (output) => !output.runtimeEventOnly,
    );
    expect(userVisibleOutputs.map((output) => output.result)).toEqual([
      'Hello ',
      'world',
      null,
    ]);
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeEventOnly: true,
          runtimeEvents: [
            expect.objectContaining({
              eventType: 'run.startup_diagnostic',
              payload: expect.objectContaining({
                diagnostic: 'runner_startup_timing',
                firstVisibleOutputMs: expect.any(Number),
              }),
            }),
          ],
        }),
      ]),
    );
  });

  it('ignores SDK thinking deltas and streams only text deltas', async () => {
    sdkState.mode = 'partial-thinking-output';
    const env = prepareRuntimeEnv();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello from Gantry',
      env.mcpServerPath,
      runnerInput(),
      sdkProcessEnv(),
      'sonnet',
      undefined,
      undefined,
    );

    const outputs = logSpy.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { result: string | null });
    logSpy.mockRestore();
    const visibleResults = outputs
      .map((output) => output.result)
      .filter((result): result is string => typeof result === 'string');

    expect(visibleResults).toEqual(['Visible answer']);
    expect(JSON.stringify(outputs)).not.toContain('hidden reasoning');
  });

  it('extracts visible text from SDK assistant content blocks without reasoning blocks', async () => {
    sdkState.mode = 'structured-thinking-output';
    const env = prepareRuntimeEnv();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello from Gantry',
      env.mcpServerPath,
      runnerInput(),
      sdkProcessEnv(),
      'sonnet',
      undefined,
      undefined,
    );

    const outputs = logSpy.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((line) => line.startsWith('{'))
      .map(
        (line) =>
          JSON.parse(line) as {
            result: string | null;
            runtimeEventOnly?: boolean;
          },
      );
    logSpy.mockRestore();
    const userVisibleOutputs = outputs.filter(
      (output) => !output.runtimeEventOnly,
    );

    expect(userVisibleOutputs.map((output) => output.result)).toEqual([
      'Visible answer.',
      null,
    ]);
    expect(JSON.stringify(outputs)).not.toContain('hidden reasoning');
    expect(JSON.stringify(outputs)).not.toContain('hidden encrypted reasoning');
  });

  it('does not fall back to SDK result text when assistant content has only reasoning blocks', async () => {
    sdkState.mode = 'structured-thinking-only-output';
    const env = prepareRuntimeEnv();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello from Gantry',
      env.mcpServerPath,
      runnerInput(),
      sdkProcessEnv(),
      'sonnet',
      undefined,
      undefined,
    );

    const outputs = logSpy.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((line) => line.startsWith('{'))
      .map(
        (line) =>
          JSON.parse(line) as {
            result: string | null;
            runtimeEventOnly?: boolean;
          },
      );
    logSpy.mockRestore();
    const userVisibleOutputs = outputs.filter(
      (output) => !output.runtimeEventOnly,
    );

    expect(userVisibleOutputs.map((output) => output.result)).toEqual([null]);
    expect(JSON.stringify(outputs)).not.toContain('hidden reasoning');
  });

  it('passes hermetic Gantry capabilities and settings into the Claude SDK', async () => {
    const env = prepareRuntimeEnv();
    const { runQuery } = await importRunQuery();

    const result = await runQuery(
      'hello from Gantry',
      env.mcpServerPath,
      runnerInput({
        memoryContextBlock:
          '<gantry_memory_context trust="untrusted_data_only">prior user preference</gantry_memory_context>',
      }),
      { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
      'sonnet',
      undefined,
      undefined,
    );

    expect(result.newSessionId).toBe('claude-session-boundary');
    const call = sdkState.calls[0];
    expect(call?.options).toMatchObject({
      model: 'sonnet',
      cwd: path.join(env.root, 'workspace', 'group'),
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      skills: ['gantry-admin', 'gantry-browser', 'linkedin-posting'],
      includePartialMessages: true,
    });
    expect(call?.options.env.ENABLE_TOOL_SEARCH).toBe('auto:10');
    expect(call?.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(call?.options.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(call?.options.allowedTools).toEqual(
      expect.arrayContaining([
        'Read',
        'Glob',
        'Grep',
        'mcp__gantry__send_message',
        'mcp__gantry__ask_user_question',
        'mcp__gantry__todo_update',
        'mcp__gantry__request_skill_install',
        'mcp__gantry__request_skill_proposal',
        'mcp__gantry__request_skill_dependency_install',
        'mcp__gantry__request_mcp_server',
        'mcp__gantry__request_access',
        'mcp__gantry__mcp_list_tools',
        'mcp__gantry__mcp_describe_tool',
        'mcp__gantry__mcp_call_tool',
        'Skill',
      ]),
    );
    expect(call?.options.allowedTools).not.toEqual(
      expect.arrayContaining([
        'Agent',
        'Task',
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskUpdate',
        'TodoWrite',
        'mcp__gantry__async_run_command',
        'mcp__gantry__async_mcp_call',
        'mcp__gantry__task_get',
        'mcp__gantry__task_list',
        'mcp__gantry__task_cancel',
        'mcp__gantry__delegate_task',
        'mcp__gantry__task_message',
      ]),
    );
    expect(call?.options.tools).toEqual(
      expect.arrayContaining([
        'Read',
        'Glob',
        'Grep',
        'Bash',
        'Write',
        'Edit',
        'LS',
        'MultiEdit',
        'NotebookEdit',
        'WebSearch',
        'WebFetch',
        'ToolSearch',
        'Skill',
      ]),
    );
    expect(call?.options.tools).not.toEqual(
      expect.arrayContaining([
        'AskUserQuestion',
        'SendMessage',
        'Agent',
        'Task',
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskUpdate',
        'TaskOutput',
        'TaskStop',
        'TodoWrite',
        'EnterWorktree',
        'ExitWorktree',
        'Browser',
      ]),
    );
    expect(call?.options.disallowedTools).toEqual(
      expect.arrayContaining([
        'AskUserQuestion',
        'SendMessage',
        'CronCreate',
        'Agent',
        'Task',
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskUpdate',
        'TaskOutput',
        'TaskStop',
        'TodoWrite',
        'EnterWorktree',
        'ExitWorktree',
      ]),
    );
    expect(call?.options.allowedTools).not.toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'Config',
        'mcp__gantry__list_models',
        'mcp__gantry__*',
        'Monitor',
        'AskUserQuestion',
      ]),
    );
    expect(call?.options.agents).toBeUndefined();
    expect(call?.options.settings.skillOverrides).toEqual(
      SDK_NATIVE_SKILL_OVERRIDES,
    );
    expect(call?.options.settings.autoMemoryEnabled).toBe(false);
    expect(call?.options.mcpServers.gantry).toEqual({
      command: 'node',
      args: [env.mcpServerPath],
      timeout: 300_000,
      alwaysLoad: true,
      env: {
        GANTRY_CHAT_JID: 'tg:group',
        GANTRY_WORKSPACE_KEY: 'group',
        GANTRY_THREAD_ID: 'thread-1',
        GANTRY_MEMORY_USER_ID: '',
        GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER: '',
        GANTRY_MEMORY_DEFAULT_SCOPE: 'group',
        GANTRY_BROWSER_PROFILE_NAME: '',
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
        GANTRY_IPC_DIR: path.join(env.root, 'ipc', 'group'),
        GANTRY_IPC_AUTH_TOKEN: 'runner-ipc-token',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: 'runner-response-verify-key',
        NO_PROXY:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
        no_proxy:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
      },
    });
    expect(call?.options.env).toEqual({
      CLAUDE_CONFIG_DIR: path.join(env.root, 'claude-config'),
      ...SDK_NATIVE_SKILL_DISABLE_ENV,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      ENABLE_TOOL_SEARCH: 'auto:10',
    });
    expect(call?.options.env).not.toHaveProperty(
      'GANTRY_MEMORY_IPC_ACTIONS_JSON',
    );
    expect(call?.options.hooks?.PreToolUse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timeout: 5,
          hooks: expect.arrayContaining([expect.any(Function)]),
        }),
      ]),
    );
    const preToolUseHook = call?.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(typeof preToolUseHook).toBe('function');
    const hookDecision = await preToolUseHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/work',
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/gantry/agents/kai_tg_1/skills/linkedin/SKILL.md',
        content: '# LinkedIn\n',
      },
      tool_use_id: 'toolu_1',
    });
    expect(hookDecision).toEqual(
      expect.objectContaining({
        continue: false,
        decision: 'block',
      }),
    );
    expect(call?.streamMessages[0]).toEqual([
      {
        type: 'text',
        text: '<gantry_memory_context trust="untrusted_data_only">prior user preference</gantry_memory_context>',
      },
      { type: 'text', text: 'hello from Gantry' },
    ]);
    expect(call?.options.systemPrompt).toEqual(
      expect.arrayContaining(['__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__']),
    );
    const systemPromptText = JSON.stringify(call?.options.systemPrompt);
    expect(systemPromptText).toContain('Gantry Durable Memory Boundary');
    expect(systemPromptText).not.toContain('prior user preference');
  });

  it('enforces require_prior through SDK Pre/PostToolUse hooks only when rules exist', async () => {
    const env = prepareRuntimeEnv();
    const { runQuery } = await importRunQuery();

    await runQuery(
      'guarded run',
      env.mcpServerPath,
      runnerInput({
        toolRules: [
          {
            tool: 'deploy',
            action: 'require_prior',
            prior: 'AgentDelegation',
            reason: 'tests must pass before deploy',
          },
          {
            tool: 'AgentDelegation',
            action: 'block',
            reason: 'delegation disabled',
          },
          {
            tool: 'mcp__crm__delete',
            action: 'block',
            reason: 'deletion disabled',
          },
        ],
      }),
      sdkProcessEnv(),
      'sonnet',
      undefined,
      undefined,
    );

    const guardedCall = sdkState.calls[0];
    const preToolUseHooks = guardedCall?.options.hooks.PreToolUse[0].hooks;
    expect(preToolUseHooks).toHaveLength(2);
    const declarativePreToolUse = preToolUseHooks[1];
    const denied = await declarativePreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'deploy',
      tool_input: {},
    });
    expect(denied).toMatchObject({
      continue: false,
      decision: 'block',
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining(
          'tests must pass before deploy',
        ),
      },
    });
    expect(JSON.parse(denied.reason)).toMatchObject({
      category: 'permission',
      isRetryable: false,
      message: expect.stringContaining('tests must pass before deploy'),
    });
    await expect(
      declarativePreToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__gantry__delegate_task',
        tool_input: {},
      }),
    ).resolves.toMatchObject({
      continue: false,
      hookSpecificOutput: {
        permissionDecisionReason: expect.stringContaining(
          'delegation disabled',
        ),
      },
    });
    await expect(
      declarativePreToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__crm__delete',
        tool_input: {},
      }),
    ).resolves.toMatchObject({
      continue: false,
      hookSpecificOutput: {
        permissionDecisionReason: expect.stringContaining('deletion disabled'),
      },
    });

    const postToolUse = guardedCall?.options.hooks.PostToolUse[0].hooks[0];
    await postToolUse({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__gantry__delegate_task',
    });
    await expect(
      declarativePreToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: 'deploy',
        tool_input: {},
      }),
    ).resolves.toEqual({ continue: true });

    await runQuery(
      'ordinary run',
      env.mcpServerPath,
      runnerInput(),
      sdkProcessEnv(),
      'sonnet',
      undefined,
      undefined,
    );
    const ordinaryCall = sdkState.calls[1];
    expect(ordinaryCall?.options.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(ordinaryCall?.options.hooks.PostToolUse).toBeUndefined();
  });

  it('passes an explicit empty SDK skills list when Gantry selected no skills', async () => {
    const env = prepareRuntimeEnv();
    vi.stubEnv(GANTRY_CLAUDE_SDK_SKILLS_ENV, JSON.stringify([]));
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello from Gantry',
      env.mcpServerPath,
      runnerInput(),
      { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
      'sonnet',
      undefined,
      undefined,
    );

    const call = sdkState.calls[0];
    expect(call?.options).toMatchObject({
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
    });
    expect(call?.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(call?.options.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });

  it('fails closed when Claude init reports the required Gantry MCP server is unavailable', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'mcp-failed';
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'hello',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/Required Gantry MCP server is not ready/);
  });

  it('passes memory reviewer authority into the Gantry MCP server env', async () => {
    const env = prepareRuntimeEnv();
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello',
      env.mcpServerPath,
      runnerInput({ memoryReviewerIsControlApprover: true }),
      {},
      undefined,
      undefined,
      undefined,
    );

    expect(
      sdkState.calls[0]?.options.mcpServers.gantry?.env
        ?.GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER,
    ).toBe('1');
    expect(
      sdkState.calls[0]?.options.mcpServers.gantry?.env
        ?.GANTRY_MCP_TOOL_NAMES_JSON,
    ).toBe(
      JSON.stringify(
        selectedGantryMcpToolNames([], {
          memoryReviewerIsControlApprover: true,
        }),
      ),
    );
    expect(
      sdkState.calls[0]?.options.mcpServers.gantry?.env
        ?.GANTRY_MEMORY_IPC_ACTIONS_JSON,
    ).toBe(
      JSON.stringify(
        selectedMemoryIpcActions([], {
          memoryReviewerIsControlApprover: true,
        }),
      ),
    );
    expect(sdkState.calls[0]?.options.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__gantry__memory_review_pending',
        'mcp__gantry__memory_review_decision',
      ]),
    );
  });

  it('passes no-permission authority hiding into the SDK capability projection', async () => {
    const env = prepareRuntimeEnv();
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello',
      env.mcpServerPath,
      runnerInput({
        hideAuthorityTools: true,
        allowedTools: [
          'mcp__gantry__send_message',
          'mcp__gantry__request_access',
          'mcp__gantry__settings_desired_state',
        ],
      }),
      {},
      undefined,
      undefined,
      undefined,
    );

    expect(sdkState.calls[0]?.options.allowedTools).toContain(
      'mcp__gantry__send_message',
    );
    expect(sdkState.calls[0]?.options.allowedTools).not.toEqual(
      expect.arrayContaining(['mcp__gantry__request_access']),
    );
    expect(sdkState.calls[0]?.options.allowedTools).not.toContain(
      'mcp__gantry__settings_desired_state',
    );
    expect(
      sdkState.calls[0]?.options.mcpServers.gantry?.env
        ?.GANTRY_MCP_TOOL_NAMES_JSON,
    ).toBe(
      JSON.stringify(
        selectedGantryMcpToolNames(
          [
            'mcp__gantry__send_message',
            'mcp__gantry__request_access',
            'mcp__gantry__settings_desired_state',
          ],
          { excludeAuthorityTools: true },
        ),
      ),
    );
  });

  it('fails closed when Claude init omits the required Gantry MCP server', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'mcp-missing';
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'hello',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/Required Gantry MCP server is missing/);
  });

  it('fails closed when Claude init omits MCP server status metadata', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'mcp-metadata-omitted';
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'hello',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/Required Gantry MCP server status is missing/);
  });

  it('promotes SDK success-result API key failures to runner errors', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'auth-result-text';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'hello',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow('Invalid API key');

    const visibleResults = logSpy.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { result: string | null })
      .map((output) => output.result);
    logSpy.mockRestore();
    expect(visibleResults).not.toContain(
      'Invalid API key · Fix external API key',
    );
  });

  it('promotes SDK billing result errors to runner errors', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'billing-result-error';
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'hello',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow('Credit balance is too low');
  });

  it('does not fail success results that only carry an empty SDK error flag', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'success-result-empty-error-flag';
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'hello',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({
      closedDuringQuery: false,
    });
  });

  it('pipes active IPC follow-up input into the same Claude SDK stream', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'active-followup';
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'initial prompt',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ newSessionId: 'claude-session-boundary' });

    expect(sdkState.calls[0]?.streamMessages).toEqual([
      'initial prompt',
      'follow-up while Claude is still running',
    ]);
  }, 5_000);

  it('does not let untrusted memory grant risky Claude tool use', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'memory-denial';
    const { runQuery } = await importRunQuery();

    await runQuery(
      'current user did not ask for shell access',
      env.mcpServerPath,
      runnerInput({
        memoryContextBlock:
          '<gantry_memory_context trust="untrusted_data_only">[suppressed: instruction-like memory content]</gantry_memory_context>',
      }),
      {},
      undefined,
      undefined,
      undefined,
    );

    expect(sdkState.calls[0]?.permissionDecision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
      }),
    );
    expect(
      String((sdkState.calls[0]?.permissionDecision as any).message),
    ).toContain('memory boundary');
  });

  it('rejects full or friendly model aliases for native Agent invocation input', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'agent-model-denial';
    const { runQuery } = await importRunQuery();

    await runQuery(
      'delegate carefully',
      env.mcpServerPath,
      runnerInput(),
      {},
      'sonnet',
      undefined,
      undefined,
    );

    expect(sdkState.calls[0]?.permissionDecision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
      }),
    );
    expect(
      String((sdkState.calls[0]?.permissionDecision as any).message),
    ).toContain('accepts only opus, sonnet, or haiku');
  });

  it('rejects native Agent tool fields that belong in configured AgentDefinition entries', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'agent-input-field-denial';
    const { runQuery } = await importRunQuery();

    await runQuery(
      'delegate carefully',
      env.mcpServerPath,
      runnerInput(),
      {},
      'sonnet',
      undefined,
      undefined,
    );

    expect(sdkState.calls[0]?.permissionDecision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
      }),
    );
    expect(
      String((sdkState.calls[0]?.permissionDecision as any).message),
    ).toContain('disallowedTools');
    expect(
      String((sdkState.calls[0]?.permissionDecision as any).message),
    ).toContain('configured subagent definition');
  });

  it('rejects legacy Task subagent tool aliases before native subagent validation', async () => {
    const env = prepareRuntimeEnv();
    const previousToolName = process.env.TEST_SUBAGENT_TOOL_NAME;
    process.env.TEST_SUBAGENT_TOOL_NAME = 'Task';
    sdkState.mode = 'agent-input-field-denial';
    const { runQuery } = await importRunQuery();

    try {
      await runQuery(
        'delegate carefully',
        env.mcpServerPath,
        runnerInput(),
        {},
        'sonnet',
        undefined,
        undefined,
      );
    } finally {
      if (previousToolName === undefined) {
        delete process.env.TEST_SUBAGENT_TOOL_NAME;
      } else {
        process.env.TEST_SUBAGENT_TOOL_NAME = previousToolName;
      }
    }

    expect(sdkState.calls[0]?.permissionDecision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
      }),
    );
    expect(
      String((sdkState.calls[0]?.permissionDecision as any).message),
    ).toContain('Use the Agent tool');
  });

  it('preserves subagent-attributed assistant messages as runner resume anchors', async () => {
    const env = prepareRuntimeEnv();
    sdkState.mode = 'subagent-attribution';
    const { runQuery } = await importRunQuery();

    await expect(
      runQuery(
        'delegate safely',
        env.mcpServerPath,
        runnerInput(),
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({
      lastAssistantUuid: 'assistant-subagent-message',
    });
  });
});
