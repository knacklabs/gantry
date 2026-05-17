import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selectedMemoryIpcActions,
  selectedMyClawMcpToolNames,
} from '@agent-runner-src/myclaw-mcp-tool-surface.js';
import type { AgentRunnerInput } from '@core/runner/claude/types.js';

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
    | 'partial-output',
  calls: [] as Array<{
    options: Record<string, any>;
    streamMessages: unknown[];
    permissionDecision?: unknown;
  }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
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
          name: 'myclaw',
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
      const inputDir = process.env.MYCLAW_IPC_INPUT_DIR || '';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-claude-sdk-'));
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
  vi.stubEnv('MYCLAW_WORKSPACE_GROUP_DIR', groupDir);
  vi.stubEnv('MYCLAW_WORKSPACE_EXTRA_DIR', extraDir);
  vi.stubEnv('MYCLAW_IPC_DIR', ipcDir);
  vi.stubEnv('MYCLAW_IPC_INPUT_DIR', inputDir);
  vi.stubEnv('MYCLAW_IPC_AUTH_TOKEN', 'runner-ipc-token');
  vi.stubEnv('MYCLAW_IPC_RESPONSE_VERIFY_KEY', 'runner-response-verify-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'raw-provider-key');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'raw-oauth-token');
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-config'));
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
    groupFolder: 'group',
    chatJid: 'tg:group',
    threadId: 'thread-1',
    compiledSystemPrompt: 'compiled MyClaw system profile',
    ...overrides,
  };
}

async function importRunQuery() {
  vi.resetModules();
  return await import('@core/runner/claude/query-loop.js');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  sdkState.mode = 'success';
  sdkState.calls.length = 0;
  vi.unstubAllEnvs();
});

describe('Claude Agent SDK boundary integration', () => {
  it('emits SDK partial text deltas as channel-visible streaming chunks', async () => {
    sdkState.mode = 'partial-output';
    const env = prepareRuntimeEnv();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runQuery } = await importRunQuery();

    await runQuery(
      'hello from MyClaw',
      env.mcpServerPath,
      runnerInput(),
      { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
      'sonnet',
      undefined,
      undefined,
    );

    const outputs = logSpy.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { result: string | null });
    logSpy.mockRestore();

    expect(outputs.map((output) => output.result)).toEqual([
      null,
      'Hello ',
      'world',
      null,
    ]);
  });

  it('passes hermetic MyClaw capabilities and settings into the Claude SDK', async () => {
    const env = prepareRuntimeEnv();
    const { runQuery } = await importRunQuery();

    const result = await runQuery(
      'hello from MyClaw',
      env.mcpServerPath,
      runnerInput({
        memoryContextBlock:
          '<myclaw_memory_context trust="untrusted_data_only">prior user preference</myclaw_memory_context>',
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
      settingSources: ['user'],
      includePartialMessages: true,
    });
    expect(call?.options.allowedTools).toEqual(
      expect.arrayContaining([
        'Read',
        'Glob',
        'Grep',
        'mcp__myclaw__send_message',
        'mcp__myclaw__ask_user_question',
        'mcp__myclaw__request_skill_install',
        'mcp__myclaw__request_skill_proposal',
        'mcp__myclaw__request_skill_dependency_install',
        'mcp__myclaw__request_mcp_server',
        'mcp__myclaw__request_permission',
        'mcp__myclaw__mcp_list_tools',
        'mcp__myclaw__mcp_call_tool',
        'Agent',
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
        'Agent',
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
        'TaskOutput',
        'TaskStop',
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
        'TaskOutput',
        'TaskStop',
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
        'mcp__myclaw__list_models',
        'mcp__myclaw__*',
        'Monitor',
        'AskUserQuestion',
      ]),
    );
    expect(call?.options.agents).toBeUndefined();
    expect(call?.options.mcpServers.myclaw).toEqual({
      command: 'node',
      args: [env.mcpServerPath],
      env: {
        MYCLAW_CHAT_JID: 'tg:group',
        MYCLAW_GROUP_FOLDER: 'group',
        MYCLAW_THREAD_ID: 'thread-1',
        MYCLAW_MEMORY_USER_ID: '',
        MYCLAW_MEMORY_REVIEWER_IS_CONTROL_APPROVER: '',
        MYCLAW_MEMORY_DEFAULT_SCOPE: 'group',
        MYCLAW_BROWSER_PROFILE_NAME: '',
        MYCLAW_ADMIN_MCP_TOOLS_JSON: '[]',
        MYCLAW_CONFIGURED_ALLOWED_TOOLS_JSON: '[]',
        MYCLAW_SELECTED_SKILLS_JSON: '[]',
        MYCLAW_SELECTED_MCP_SERVERS_JSON: '[]',
        MYCLAW_MCP_TOOL_NAMES_JSON: JSON.stringify(
          selectedMyClawMcpToolNames([]),
        ),
        MYCLAW_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(
          selectedMemoryIpcActions([]),
        ),
        MYCLAW_IPC_DIR: path.join(env.root, 'ipc', 'group'),
        MYCLAW_IPC_AUTH_TOKEN: 'runner-ipc-token',
        MYCLAW_IPC_RESPONSE_VERIFY_KEY: 'runner-response-verify-key',
        NO_PROXY:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
        no_proxy:
          '127.0.0.1,localhost,::1,github.com,.github.com,api.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com',
      },
    });
    expect(call?.options.env).toEqual({
      CLAUDE_CONFIG_DIR: path.join(env.root, 'claude-config'),
    });
    expect(call?.options.env).not.toHaveProperty(
      'MYCLAW_MEMORY_IPC_ACTIONS_JSON',
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
        file_path: '/tmp/myclaw/agents/kai_tg_1/skills/linkedin/SKILL.md',
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
        text: '<myclaw_memory_context trust="untrusted_data_only">prior user preference</myclaw_memory_context>',
      },
      { type: 'text', text: 'hello from MyClaw' },
    ]);
    expect(call?.options.systemPrompt.append).toContain(
      'MyClaw Durable Memory Boundary',
    );
    expect(call?.options.systemPrompt.append).not.toContain(
      'prior user preference',
    );
  });

  it('fails closed when Claude init reports the required MyClaw MCP server is unavailable', async () => {
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
    ).rejects.toThrow(/Required MyClaw MCP server is not ready/);
  });

  it('passes memory reviewer authority into the MyClaw MCP server env', async () => {
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
      sdkState.calls[0]?.options.mcpServers.myclaw?.env
        ?.MYCLAW_MEMORY_REVIEWER_IS_CONTROL_APPROVER,
    ).toBe('1');
  });

  it('fails closed when Claude init omits the required MyClaw MCP server', async () => {
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
    ).rejects.toThrow(/Required MyClaw MCP server is missing/);
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
    ).rejects.toThrow(/Required MyClaw MCP server status is missing/);
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
          '<myclaw_memory_context trust="untrusted_data_only">[suppressed: instruction-like memory content]</myclaw_memory_context>',
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

  it('rejects legacy Task tool fields through the same native subagent guard', async () => {
    const env = prepareRuntimeEnv();
    env.TEST_SUBAGENT_TOOL_NAME = 'Task';
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
