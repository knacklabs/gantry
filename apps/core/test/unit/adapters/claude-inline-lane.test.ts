import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  createServer: vi.fn((options) => ({
    type: 'sdk',
    name: options.name,
    instance: options,
  })),
  createTool: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));

const remoteProxy = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(async () => undefined),
}));

const claudeSdkPackage = vi.hoisted(() =>
  ['@anthropic-ai', 'claude-agent-sdk'].join('/'),
);

vi.mock(claudeSdkPackage, () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'dynamic-boundary',
  query: sdk.query,
  createSdkMcpServer: sdk.createServer,
  tool: sdk.createTool,
}));

vi.mock(
  '@core/adapters/llm/anthropic-claude-agent/inline-lane/remote-mcp-proxy.js',
  () => ({ createPinnedClaudeMcpProxies: remoteProxy.create }),
);

import { runClaudeInlineAgentLoopLane } from '@core/adapters/llm/anthropic-claude-agent/inline-lane/index.js';
import { InMemoryInlineRunnerControlPort } from '@core/runtime/agent-inline.js';
import { DEFAULT_AGENT_ENGINE } from '@core/shared/agent-engine.js';

function laneInput(overrides: Record<string, unknown> = {}) {
  const gatewayBaseUrlKey = ['ANTHROPIC', 'BASE_URL'].join('_');
  const gatewayTokenKey = ['ANTHROPIC', 'API_KEY'].join('_');
  const coreTools = {
    tools: [
      {
        name: 'send_message',
        description: 'Send a message.',
        inputSchema: z.object({ text: z.string() }),
      },
    ],
    execute: vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'sent' }],
    })),
    authorizeThirdPartyMcpTool: vi.fn(async () => ({ allowed: true })),
    recordThirdPartyMcpToolActivity: vi.fn(async () => undefined),
  };
  return {
    group: {
      name: 'Test',
      folder: 'main_agent',
      trigger: '@test',
      added_at: new Date(0).toISOString(),
    },
    input: {
      prompt: 'first prompt',
      workspaceFolder: 'main_agent',
      chatJid: 'conversation:test',
      compiledSystemPrompt: 'system prompt',
    },
    signal: new AbortController().signal,
    controlPort: new InMemoryInlineRunnerControlPort(),
    resolvedModel: {
      ok: true,
      value: {
        agentEngine: DEFAULT_AGENT_ENGINE,
        runnerModel: 'test-model',
        modelEntry: {
          displayName: 'Test model',
          modelRoute: { id: ['an', 'thropic'].join('') },
        },
      },
    },
    modelCredentialEnv: {
      [gatewayBaseUrlKey]: 'http://127.0.0.1:9999',
      [gatewayTokenKey]: 'gtw_test',
    },
    mcpServers: [
      {
        name: 'crm',
        config: { type: 'http', url: 'https://mcp.example.test/rpc' },
        allowedToolNames: ['mcp__crm__read'],
        allowedToolPatterns: ['read'],
        autoApproveToolNames: ['mcp__crm__read'],
        autoApproveToolPatterns: ['read'],
      },
    ],
    egressDenylist: [],
    runtimeDataDir: '/tmp/gantry-inline-test',
    emitOutput: vi.fn(async () => undefined),
    coreTools,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  remoteProxy.create.mockResolvedValue({
    servers: [
      {
        name: 'crm',
        type: 'http',
        url: 'http://127.0.0.1:43210/rpc',
        headers: { 'x-gantry-inline-mcp-token': 'proxy-token' },
        allowedToolPatterns: ['read'],
        autoApproveToolPatterns: ['read'],
      },
    ],
    close: remoteProxy.close,
  });
});

describe('Claude inline lane', () => {
  it.each([
    ['uses the default cap when unset', {}, 50, undefined],
    [
      'maps configured iteration settings',
      { maxTurns: 6, effort: 'xhigh' },
      6,
      'xhigh',
    ],
  ])('%s', async (_name, overrides, expectedMaxTurns, expectedEffort) => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield resultMessage('iteration-result', 'done');
      },
    }));

    await runClaudeInlineAgentLoopLane(laneInput(overrides));

    const options = sdk.query.mock.calls[0]?.[0].options;
    expect(options.maxTurns).toBe(expectedMaxTurns);
    expect(options.effort).toBe(expectedEffort);
    expect(options.outputFormat).toBeUndefined();
  });

  it.each([
    [{ mode: 'off' }, { type: 'disabled' }],
    [{ mode: 'on' }, { type: 'adaptive' }],
    [
      { mode: 'on', budgetTokens: 4096 },
      { type: 'enabled', budgetTokens: 4096 },
    ],
  ])(
    'maps configured thinking %j into SDK options',
    async (configuredThinking, expected) => {
      sdk.query.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield resultMessage('thinking-result', 'done');
        },
      }));

      await runClaudeInlineAgentLoopLane(laneInput({ configuredThinking }));

      expect(sdk.query.mock.calls[0]?.[0].options.thinking).toMatchObject(
        expected,
      );
    },
  );

  it('returns SDK-validated structured output as JSON', async () => {
    const responseSchema = {};
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          ...resultMessage('structured-result', 'ignored text'),
          structured_output: { answer: 'done' },
        };
      },
    }));

    const input = laneInput({
      input: { ...laneInput().input, responseSchema },
    });
    const result = await runClaudeInlineAgentLoopLane(input);

    expect(sdk.query.mock.calls[0]?.[0].options.outputFormat).toEqual({
      type: 'json_schema',
      schema: responseSchema,
    });
    expect(result).toMatchObject({
      status: 'success',
      result: JSON.stringify({ answer: 'done' }),
    });
    expect(input.emitOutput).toHaveBeenLastCalledWith(result);
  });

  it('returns a shaped error when structured output violates the schema', async () => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          errors: ['Structured output did not match the schema.'],
        };
      },
    }));
    const input = laneInput({
      input: {
        ...laneInput().input,
        responseSchema: { type: 'object' },
      },
    });

    const result = await runClaudeInlineAgentLoopLane(input);

    expect(result).toEqual({
      status: 'error',
      result: null,
      error: 'Structured output did not match the schema.',
    });
    expect(input.emitOutput).toHaveBeenLastCalledWith(result);
  });

  it('emits and returns a named max_turns terminal error', async () => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'error_max_turns' };
      },
    }));
    const input = laneInput({ maxTurns: 2 });

    const result = await runClaudeInlineAgentLoopLane(input);

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/max_turns cap.*configured limit: 2/),
    });
    expect(input.emitOutput).toHaveBeenLastCalledWith(result);
  });

  it('mounts core tools in an SDK MCP server and keeps remote MCP native', async () => {
    const prompts: unknown[] = [];
    let releaseFirstResult: (() => void) | undefined;
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const iterator = prompt[Symbol.asyncIterator]();
        prompts.push((await iterator.next()).value);
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'session-1',
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'first' },
          },
        };
        await new Promise<void>((resolve) => {
          releaseFirstResult = resolve;
        });
        yield resultMessage('result-1', 'first');
        prompts.push((await iterator.next()).value);
        yield resultMessage('result-2', 'second');
      },
    }));
    const input = laneInput();
    const result = runClaudeInlineAgentLoopLane(input);
    await vi.waitFor(() =>
      expect(input.emitOutput).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'first' }),
      ),
    );
    await vi.waitFor(() =>
      expect(releaseFirstResult).toEqual(expect.any(Function)),
    );

    input.controlPort.writeContinuationInput({
      workspaceFolder: 'main_agent',
      text: 'follow up',
      sequence: 2,
    });
    releaseFirstResult?.();
    await expect(result).resolves.toMatchObject({
      status: 'success',
      usageEventId: 'result-2',
    });

    expect(sdk.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'gantry',
        tools: [expect.objectContaining({ name: 'send_message' })],
      }),
    );
    const queryOptions = sdk.query.mock.calls[0]?.[0].options;
    expect(queryOptions.mcpServers).toMatchObject({
      gantry: { type: 'sdk' },
      crm: {
        type: 'http',
        url: 'http://127.0.0.1:43210/rpc',
        headers: { 'x-gantry-inline-mcp-token': 'proxy-token' },
        tools: [{ name: 'read', permission_policy: 'always_ask' }],
      },
    });
    expect(queryOptions.allowedTools).toEqual(['mcp__gantry__send_message']);
    expect(queryOptions.env).toMatchObject(input.modelCredentialEnv);
    expect(queryOptions.env[['CLAUDE', 'CONFIG_DIR'].join('_')]).toContain(
      '/tmp/gantry-inline-test',
    );
    expect(queryOptions.systemPrompt.join('\n')).toContain('system prompt');
    await expect(
      queryOptions.canUseTool(
        'mcp__crm__read',
        { id: 'crm-1' },
        {
          signal: input.signal,
          toolUseID: 'tool-1',
        },
      ),
    ).resolves.toMatchObject({ behavior: 'allow', toolUseID: 'tool-1' });
    expect(input.coreTools.authorizeThirdPartyMcpTool).toHaveBeenCalledWith(
      'mcp__crm__read',
      { id: 'crm-1' },
      { signal: input.signal },
    );
    await expect(
      queryOptions.canUseTool(
        'Bash',
        { command: 'echo unsafe' },
        { signal: input.signal, toolUseID: 'tool-unknown' },
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      queryOptions.canUseTool(
        'mcp__crm__delete',
        { id: 'crm-1' },
        { signal: input.signal, toolUseID: 'tool-2' },
      ),
    ).resolves.toMatchObject({ behavior: 'deny', toolUseID: 'tool-2' });
    expect(input.coreTools.authorizeThirdPartyMcpTool).toHaveBeenCalledTimes(1);
    await expect(
      queryOptions.hooks.PreToolUse[0].hooks[0](
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__crm__delete',
          tool_input: { id: 'crm-1' },
          tool_use_id: 'tool-2',
        },
        'tool-2',
        { signal: input.signal },
      ),
    ).resolves.toMatchObject({
      continue: false,
      decision: 'block',
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await queryOptions.hooks.PreToolUse[0].hooks[0](
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__crm__read',
        tool_input: { id: 'crm-1' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: input.signal },
    );
    await queryOptions.hooks.PostToolUse[0].hooks[0](
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__crm__read',
        tool_input: { id: 'crm-1' },
        tool_response: 'done',
        tool_use_id: 'tool-1',
        duration_ms: 5,
      },
      'tool-1',
      { signal: input.signal },
    );
    expect(
      input.coreTools.recordThirdPartyMcpToolActivity,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'crm',
        toolName: 'read',
        outcome: 'attempt',
      }),
    );
    expect(
      input.coreTools.recordThirdPartyMcpToolActivity,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'crm',
        toolName: 'read',
        outcome: 'success',
        latencyMs: 5,
      }),
    );
    expect(remoteProxy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: input.mcpServers,
        egressDenylist: [],
      }),
    );
    expect(prompts).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ content: 'first prompt' }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({ content: 'follow up' }),
      }),
    ]);

    const sdkTool = sdk.createTool.mock.results[0]?.value;
    await sdkTool.handler({ text: 'hello' }, {});
    expect(input.coreTools.execute).toHaveBeenCalledWith(
      'send_message',
      { text: 'hello' },
      { signal: input.signal },
    );
    expect(input.emitOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'first', newSessionId: 'session-1' }),
    );
    expect(input.emitOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        usageEventId: 'result-1',
        continuedByFollowup: true,
      }),
    );
    expect(remoteProxy.close).toHaveBeenCalledOnce();
  });

  it('continues the SDK-managed session after a compact boundary', async () => {
    const prompts: unknown[] = [];
    let releasePostCompactTurn: (() => void) | undefined;
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const iterator = prompt[Symbol.asyncIterator]();
        prompts.push((await iterator.next()).value);
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'long-session',
        };
        yield resultMessage('pre-compact-result', 'captured ticket-42');
        yield { type: 'system', subtype: 'compact_boundary' };
        await new Promise<void>((resolve) => {
          releasePostCompactTurn = resolve;
        });
        prompts.push((await iterator.next()).value);
        yield resultMessage(
          'post-compact-result',
          'continued ticket-42 after compact',
        );
      },
    }));
    const input = laneInput();

    const result = runClaudeInlineAgentLoopLane(input);
    await vi.waitFor(() =>
      expect(input.emitOutput).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'captured ticket-42' }),
      ),
    );
    await vi.waitFor(() =>
      expect(input.emitOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          compactBoundary: true,
          newSessionId: 'long-session',
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(releasePostCompactTurn).toEqual(expect.any(Function)),
    );

    input.controlPort.writeContinuationInput({
      workspaceFolder: 'main_agent',
      text: 'continue ticket-42',
      sequence: 2,
    });
    releasePostCompactTurn?.();

    await expect(result).resolves.toMatchObject({
      status: 'success',
      result: 'continued ticket-42 after compact',
      newSessionId: 'long-session',
      usageEventId: 'post-compact-result',
    });
    expect(prompts).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ content: 'first prompt' }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({ content: 'continue ticket-42' }),
      }),
    ]);
    expect(remoteProxy.close).toHaveBeenCalledOnce();
  });

  it('enforces reviewed wildcard scopes in the remote MCP tool gate', async () => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield resultMessage('wildcard-result', 'done');
      },
    }));

    for (const testCase of [
      {
        patterns: ['read_*'],
        allowedTool: 'mcp__crm__read_contacts',
        deniedTool: 'mcp__crm__write_contacts',
      },
      {
        patterns: ['*'],
        allowedTool: 'mcp__crm__write_contacts',
      },
    ]) {
      remoteProxy.create.mockResolvedValueOnce({
        servers: [
          {
            name: 'crm',
            type: 'http',
            url: 'http://127.0.0.1:43210/rpc',
            headers: { 'x-gantry-inline-mcp-token': 'proxy-token' },
            allowedToolPatterns: testCase.patterns,
          },
        ],
        close: remoteProxy.close,
      });
      const base = laneInput();
      const input = laneInput({
        mcpServers: [
          {
            ...base.mcpServers[0],
            allowedToolPatterns: testCase.patterns,
          },
        ],
      });

      await runClaudeInlineAgentLoopLane(input);

      const queryOptions = sdk.query.mock.calls.at(-1)?.[0].options;
      expect(queryOptions.mcpServers.crm.tools).toBeUndefined();
      expect(queryOptions.permissionMode).toBe('dontAsk');
      expect(queryOptions.allowedTools).not.toContain(testCase.allowedTool);
      const invokePreToolUse = (toolName: string) =>
        queryOptions.hooks.PreToolUse[0].hooks[0](
          {
            hook_event_name: 'PreToolUse',
            tool_name: toolName,
            tool_input: {},
            tool_use_id: toolName,
          },
          toolName,
          { signal: input.signal },
        );
      await expect(invokePreToolUse(testCase.allowedTool)).resolves.toEqual({
        continue: true,
      });
      expect(input.coreTools.authorizeThirdPartyMcpTool).not.toHaveBeenCalled();
      await expect(
        queryOptions.canUseTool(
          testCase.allowedTool,
          {},
          { signal: input.signal, toolUseID: 'allowed-tool' },
        ),
      ).resolves.toMatchObject({ behavior: 'allow' });
      expect(input.coreTools.authorizeThirdPartyMcpTool).toHaveBeenCalledTimes(
        1,
      );
      expect(input.coreTools.authorizeThirdPartyMcpTool).toHaveBeenCalledWith(
        testCase.allowedTool,
        {},
        { signal: input.signal },
      );
      if (testCase.deniedTool) {
        await expect(
          invokePreToolUse(testCase.deniedTool),
        ).resolves.toMatchObject({
          continue: false,
          hookSpecificOutput: { permissionDecision: 'deny' },
        });
        await expect(
          queryOptions.canUseTool(
            testCase.deniedTool,
            {},
            { signal: input.signal, toolUseID: 'denied-tool' },
          ),
        ).resolves.toMatchObject({ behavior: 'deny' });
        expect(
          input.coreTools.authorizeThirdPartyMcpTool,
        ).not.toHaveBeenCalledWith(
          testCase.deniedTool,
          expect.anything(),
          expect.anything(),
        );
      }
    }
  });

  it('terminates when the run signal is aborted', async () => {
    sdk.query.mockImplementation(({ options }) => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'session-abort',
        };
        await new Promise<void>((resolve) =>
          options.abortController.signal.addEventListener(
            'abort',
            () => resolve(),
            {
              once: true,
            },
          ),
        );
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    }));
    const controller = new AbortController();
    const input = laneInput({ signal: controller.signal });
    const result = runClaudeInlineAgentLoopLane(input);
    await vi.waitFor(() =>
      expect(input.emitOutput).toHaveBeenCalledWith(
        expect.objectContaining({ sessionInit: true }),
      ),
    );

    controller.abort();

    await expect(result).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('aborted'),
      newSessionId: 'session-abort',
    });
    expect(remoteProxy.close).toHaveBeenCalledOnce();
  });

  it('emits scheduled tool activity for core and remote tools', async () => {
    sdk.query.mockImplementation(({ options }) => ({
      async *[Symbol.asyncIterator]() {
        const coreTool = options.mcpServers.gantry.instance.tools[0];
        await coreTool.handler({ text: 'scheduled hello' }, {});
        const hookInput = {
          tool_name: 'mcp__crm__read',
          tool_input: { id: 'scheduled-crm' },
          tool_use_id: 'scheduled-tool-1',
        };
        await options.hooks.PreToolUse[0].hooks[0](
          { ...hookInput, hook_event_name: 'PreToolUse' },
          hookInput.tool_use_id,
          { signal: options.abortController.signal },
        );
        await options.hooks.PostToolUse[0].hooks[0](
          {
            ...hookInput,
            hook_event_name: 'PostToolUse',
            tool_response: 'done',
          },
          hookInput.tool_use_id,
          { signal: options.abortController.signal },
        );
        yield resultMessage('scheduled-result', 'done');
      },
    }));
    const input = laneInput({
      input: {
        ...laneInput().input,
        isScheduledJob: true,
        sessionId: 'scheduled-session-must-not-resume',
      },
    });

    await expect(runClaudeInlineAgentLoopLane(input)).resolves.toMatchObject({
      status: 'success',
    });
    const queryOptions = sdk.query.mock.calls[0]?.[0].options;
    expect(queryOptions.persistSession).toBe(false);
    expect(queryOptions.resume).toBeUndefined();
    for (const tool of ['send_message', 'mcp__crm__read']) {
      expect(input.emitOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeEventOnly: true,
          runtimeEvents: [
            expect.objectContaining({
              eventType: 'job.tool_activity',
              payload: expect.objectContaining({ phase: 'started', tool }),
            }),
          ],
        }),
      );
    }
  });

  it('uses a unique fallback usage id for each resumed inline run', async () => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'done',
          usage: { input_tokens: 4, output_tokens: 2 },
        };
      },
    }));
    const resumedInput = () => {
      const input = laneInput();
      return laneInput({ input: { ...input.input, sessionId: 'session-1' } });
    };

    const first = await runClaudeInlineAgentLoopLane(resumedInput());
    const second = await runClaudeInlineAgentLoopLane(resumedInput());

    for (const call of sdk.query.mock.calls) {
      expect(call[0].options).toMatchObject({
        persistSession: true,
        resume: 'session-1',
      });
    }
    expect(first.usageEventId).toContain('session-1:run:');
    expect(second.usageEventId).not.toBe(first.usageEventId);
  });
});

function resultMessage(id: string, result: string) {
  return {
    type: 'result',
    subtype: 'success',
    uuid: id,
    result,
    usage: { input_tokens: 4, output_tokens: 2 },
  };
}
