import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildExternalNotificationAdaptiveCard,
  createAnthropicStructuredModelProvider,
  createBotFrameworkTeamsTransport,
  createFirecrawlCrawlProvider,
  createFirecrawlDiscoveryToolProviderSet,
  createFirecrawlFetchProvider,
  createFirecrawlMapProvider,
  createFirecrawlSearchProvider,
  createHttpFetchProvider,
  createGantryBrowserGatewayAgentTools,
  createGantryClient,
  createGantryRuntime,
  createPgGantryRuntimeStorage,
  createStructuredModelTaskRunner,
  createTavilySearchProvider,
  parseExternalCardAction,
  signExternalCardAction,
  signExternalEventRequest,
  verifyExternalCardAction,
  verifyExternalEventSignature,
  verifyWebhookSignature,
  type BotFrameworkAdapterLike,
} from '../src/index.js';
import {
  normalizeAgentMaxSteps,
  summarizeAgentObservation,
} from '../src/tasks/agent-task-runner-helpers.js';

describe('@cawstudios/agent-gantry', () => {
  it('allows generic agent loops to run up to 100 steps', () => {
    expect(normalizeAgentMaxSteps(100)).toBe(100);
    expect(normalizeAgentMaxSteps(101)).toBe(100);
  });

  it('uses modelStepTimeoutMs for generic agent model steps', async () => {
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () =>
          await new Promise<Record<string, unknown>>((resolve) => {
            setTimeout(() => resolve({ action: 'final', output: {} }), 50);
          }),
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.timeout.model',
      instructions: 'Return JSON.',
      input: {},
      tools: [],
      maxSteps: 1,
      modelStepTimeoutMs: 5,
      stepTimeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: 'failed',
      output: { error: 'agent_model_step_timeout' },
    });
  });

  it('accepts markdown-fenced JSON from structured model task final output', async () => {
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () =>
          [
            '```json',
            JSON.stringify({ action: 'final', output: { status: 'ok' } }),
            '```',
          ].join('\n'),
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.fenced-json',
      instructions: 'Return raw JSON.',
      input: {},
      tools: [],
      maxSteps: 1,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: { status: 'ok' },
    });
  });

  it('returns aggregate model usage from multi-step generic agent tasks', async () => {
    let callCount = 0;
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () => {
          callCount += 1;
          return {
            output: callCount === 1
              ? { action: 'call_tool', toolName: 'lookup', input: { q: 'x' } }
              : { action: 'final', output: { status: 'ok' } },
            modelUsage: {
              provider: 'anthropic',
              model: 'claude-test',
              taskType: 'task.agent.usage',
              inputTokens: callCount === 1 ? 10 : 20,
              outputTokens: callCount === 1 ? 2 : 3,
              totalTokens: callCount === 1 ? 12 : 23,
              cacheReadInputTokens: callCount === 1 ? 1 : 4,
              durationMs: callCount === 1 ? 100 : 200,
              usageSource: 'provider',
            },
          };
        },
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.agent.usage',
      instructions: 'Use the tool, then finish.',
      input: {},
      tools: [{
        name: 'lookup',
        execute: async () => ({ status: 'ok' }),
      }],
      maxSteps: 2,
      correlationId: 'agent-usage-1',
    });

    expect(result?.status).toBe('completed');
    expect(result?.modelUsage).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test',
      taskType: 'task.agent.usage',
      correlationId: 'agent-usage-1',
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      cacheReadInputTokens: 5,
      durationMs: 300,
      usageSource: 'provider',
    });
  });

  it('includes tool timeout recovery model usage in generic agent task usage', async () => {
    let callCount = 0;
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () => {
          callCount += 1;
          return {
            output: callCount === 1
              ? { action: 'call_tool', toolName: 'slow', input: {} }
              : { action: 'final', output: { status: 'recovered' } },
            modelUsage: {
              provider: 'anthropic',
              model: 'claude-test',
              inputTokens: callCount === 1 ? 7 : 11,
              outputTokens: callCount === 1 ? 1 : 2,
              totalTokens: callCount === 1 ? 8 : 13,
              usageSource: 'provider',
            },
          };
        },
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.agent.recovery-usage',
      instructions: 'Recover from tool timeout.',
      input: {},
      tools: [{
        name: 'slow',
        execute: async () => {
          throw new Error('agent_tool_timeout:slow');
        },
      }],
      recoverFromToolError: async () => ({ attempt: 'tool_error_recovery' }),
      maxSteps: 1,
      correlationId: 'agent-recovery-usage-1',
    });

    expect(result?.status).toBe('completed');
    expect(result?.modelUsage).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 18,
      outputTokens: 3,
      totalTokens: 21,
      usageSource: 'provider',
    });
  });

  it('accepts markdown-fenced JSON with surrounding text from structured model task final output', async () => {
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () =>
          [
            'Here is the final JSON:',
            '```json',
            JSON.stringify({ action: 'final', output: { status: 'ok' } }),
            '```',
            'Done.',
          ].join('\n'),
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.noisy-fenced-json',
      instructions: 'Return raw JSON.',
      input: {},
      tools: [],
      maxSteps: 1,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: { status: 'ok' },
    });
  });

  it('still rejects non-JSON prose from structured model task final output', async () => {
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () =>
          'Here is the answer: {"action":"final","output":{"status":"ok"}}',
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.prose-json',
      instructions: 'Return raw JSON.',
      input: {},
      tools: [],
      maxSteps: 1,
    });

    expect(result).toMatchObject({
      status: 'failed',
    });
    expect(String(result?.output.error)).toContain('Unexpected token');
  });

  it('can retry a timed-out model step with projected state', async () => {
    let calls = 0;
    const seenInputSizes: number[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async ({ input }) => {
          calls += 1;
          seenInputSizes.push(JSON.stringify(input).length);
          if (calls === 1) {
            return await new Promise<Record<string, unknown>>((resolve) => {
              setTimeout(
                () => resolve({ action: 'final', output: { status: 'late' } }),
                50,
              );
            });
          }
          return { action: 'final', output: { status: 'ok' } };
        },
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.timeout.projected-retry',
      instructions: 'Return JSON.',
      input: { large: 'x'.repeat(10_000) },
      tools: [],
      maxSteps: 1,
      modelStepTimeoutMs: 5,
      projectStepStateForModel: ({ attempt, state }) =>
        attempt === 'timeout_retry'
          ? {
              input: { retry: true },
              observations: [],
              agentMemory: { nextGoal: { recommendedTool: 'final' } },
            }
          : state,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: { status: 'ok' },
    });
    expect(calls).toBe(2);
    expect(seenInputSizes[1]).toBeLessThan(seenInputSizes[0] ?? 0);
  });

  it('uses toolStepTimeoutMs for generic agent tool steps', async () => {
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () => ({
          action: 'call_tool',
          toolName: 'slow_tool',
          input: {},
          previousGoalEvaluation: {
            goal: null,
            status: 'not_evaluated',
            evidenceRefs: [],
            reason: 'Start.',
          },
          memoryUpdate: {},
          nextGoal: {
            goal: 'Call slow tool.',
            requiredEvidence: [],
            recommendedTool: 'slow_tool',
          },
        }),
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.timeout.tool',
      instructions: 'Call the slow tool.',
      input: {},
      tools: [
        {
          name: 'slow_tool',
          execute: async () =>
            await new Promise<Record<string, unknown>>((resolve) => {
              setTimeout(() => resolve({ status: 'ok' }), 50);
            }),
        },
      ],
      maxSteps: 1,
      modelStepTimeoutMs: 1_000,
      toolStepTimeoutMs: 5,
      stepTimeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: 'failed',
      output: { error: 'agent_tool_timeout:slow_tool' },
    });
  });

  it('can recover a timed-out tool with a final-only model step', async () => {
    let modelCalls = 0;
    let recoveryHookCalls = 0;
    let recoveryAvailableToolCount: number | null = null;
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async ({ input }) => {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              action: 'call_tool',
              toolName: 'slow_tool',
              input: { value: 'first' },
              previousGoalEvaluation: {
                goal: null,
                status: 'not_evaluated',
                evidenceRefs: [],
                reason: 'Start.',
              },
              memoryUpdate: {},
              nextGoal: {
                goal: 'Call slow tool.',
                requiredEvidence: [],
                recommendedTool: 'slow_tool',
              },
            };
          }
          recoveryAvailableToolCount = Array.isArray(input.availableTools)
            ? input.availableTools.length
            : null;
          return {
            action: 'final',
            output: { status: 'completed', recovered: true },
            previousGoalEvaluation: {
              goal: 'Recover from tool timeout.',
              status: 'passed',
              evidenceRefs: [],
              reason: 'Returned a final response.',
            },
            memoryUpdate: {},
            nextGoal: {
              goal: 'Done.',
              requiredEvidence: [],
              recommendedTool: null,
            },
          };
        },
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.timeout.tool-recovery',
      instructions: 'Call the slow tool.',
      input: { large: 'x'.repeat(10_000) },
      tools: [
        {
          name: 'slow_tool',
          execute: async () =>
            await new Promise<Record<string, unknown>>((resolve) => {
              setTimeout(() => resolve({ status: 'ok' }), 50);
            }),
        },
      ],
      maxSteps: 1,
      modelStepTimeoutMs: 1_000,
      toolStepTimeoutMs: 5,
      recoverFromToolError: ({ error, toolName, toolInput, state }) => {
        recoveryHookCalls += 1;
        expect(error).toBe('agent_tool_timeout:slow_tool');
        expect(toolName).toBe('slow_tool');
        expect(toolInput).toEqual({ value: 'first' });
        expect(state.input).toMatchObject({ large: expect.any(String) });
        return { instructions: 'Return final JSON now.', tools: [] };
      },
      projectStepStateForModel: ({ attempt, state }) =>
        attempt === 'tool_error_recovery'
          ? {
              input: { recovery: true },
              observations: [],
              agentMemory: { nextGoal: { recommendedTool: 'final' } },
            }
          : state,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: { status: 'completed', recovered: true },
    });
    expect(modelCalls).toBe(2);
    expect(recoveryHookCalls).toBe(1);
    expect(recoveryAvailableToolCount).toBe(0);
    expect(result?.steps.map((step) => step.status)).toEqual([
      'failed',
      'completed',
    ]);
  });

  it('keeps stepTimeoutMs as the generic agent timeout fallback', async () => {
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () =>
          await new Promise<Record<string, unknown>>((resolve) => {
            setTimeout(() => resolve({ action: 'final', output: {} }), 50);
          }),
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'task.timeout.legacy',
      instructions: 'Return JSON.',
      input: {},
      tools: [],
      maxSteps: 1,
      stepTimeoutMs: 5,
    });

    expect(result).toMatchObject({
      status: 'failed',
      output: { error: 'agent_model_step_timeout' },
    });
  });

  it('maps Tavily search responses into structured search results', async () => {
    const provider = createTavilySearchProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                url: 'https://example.gov/Resources',
                title: 'Resources',
                content: 'Bid notices',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.search({ query: 'karnataka Resources', limit: 1 }),
    ).resolves.toMatchObject({
      provider: 'tavily',
      items: [
        {
          url: 'https://example.gov/Resources',
          title: 'Resources',
          snippet: 'Bid notices',
        },
      ],
    });
  });

  it('maps Firecrawl search responses into structured search results', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = createFirecrawlSearchProvider({
      apiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: [
              {
                url: 'https://example.gov/Resources',
                title: 'Resources',
                markdown: 'Bid notices and procurement updates',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      provider.search({ query: 'karnataka Resources', limit: 1 }),
    ).resolves.toMatchObject({
      provider: 'firecrawl-search',
      items: [
        {
          url: 'https://example.gov/Resources',
          title: 'Resources',
          snippet: 'Bid notices and procurement updates',
        },
      ],
    });
    expect(requestBody).toEqual({ query: 'karnataka Resources', limit: 1 });
  });

  it('maps Firecrawl map responses into structured link results', async () => {
    const provider = createFirecrawlMapProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            links: [
              'https://example.gov/Resources',
              { url: 'https://example.gov/procurement', title: 'Procurement' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.map({ url: 'https://example.gov', limit: 2 }),
    ).resolves.toMatchObject({
      startUrl: 'https://example.gov',
      provider: 'firecrawl-map',
      links: [
        { url: 'https://example.gov/Resources' },
        { url: 'https://example.gov/procurement', title: 'Procurement' },
      ],
    });
  });

  it('creates source discovery providers with search, map, http fetch, and crawl', () => {
    const tools = createFirecrawlDiscoveryToolProviderSet({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    expect(tools.search).toBeDefined();
    expect(tools.map).toBeDefined();
    expect(tools.fetch).toBeDefined();
    expect(tools.crawl).toBeDefined();
  });

  it('maps Anthropic message responses into structured JSON model output', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      taskModels: { 'task.test': 'claude-task' },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              cache_read_input_tokens: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'task.test',
        instructions: 'Return JSON.',
        input: { value: 1 },
        correlationId: 'corr-1',
      }),
    ).resolves.toMatchObject({
      output: { status: 'completed' },
      modelUsage: {
        provider: 'anthropic',
        model: 'claude-task',
        taskType: 'task.test',
        correlationId: 'corr-1',
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        cachedTokens: 2,
        usageSource: 'provider',
      },
    });
    expect(requestBody).toMatchObject({
      model: 'claude-task',
      max_tokens: 4096,
      messages: [{ role: 'user' }],
    });
    expect(requestBody).not.toHaveProperty('temperature');
    expect(requestBody).not.toHaveProperty('thinking');
    expect(requestBody).not.toHaveProperty('output_config');
    expect(JSON.stringify(requestBody)).not.toContain('test-key');
  });

  it('adds Anthropic prompt cache control only to the stable prefix block', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
            usage: {
              input_tokens: 100,
              output_tokens: 5,
              cache_creation_input_tokens: 40,
              cache_read_input_tokens: 60,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'agent.tender.deep_analysis.section',
        instructions: 'Return JSON for commercial financial terms.',
        cacheablePrefix: 'stable tender evidence scope',
        promptCache: { enabled: true, ttl: '1h', prefixHash: 'prefix-hash' },
        input: {
          sectionKey: 'commercial_financial_terms',
          correlationId: 'dynamic-correlation',
        },
        correlationId: 'dynamic-correlation',
      }),
    ).resolves.toMatchObject({
      output: { status: 'completed' },
      modelUsage: {
        cacheCreationInputTokens: 40,
        cacheReadInputTokens: 60,
        promptCacheTtl: '1h',
        promptCachePrefixHash: 'prefix-hash',
      },
    });

    const messages = requestBody?.messages as Array<{ content?: unknown }> | undefined;
    const content = messages?.[0]?.content as Array<Record<string, unknown>>;
    expect(String(requestBody?.system)).not.toContain('commercial financial terms');
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: 'text',
      text: 'stable tender evidence scope',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(JSON.stringify(content[0])).not.toContain('commercial_financial_terms');
    expect(JSON.stringify(content[0])).not.toContain('dynamic-correlation');
    expect(content[1]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(content[1])).toContain('Return JSON for commercial financial terms.');
    expect(JSON.stringify(content[1])).toContain('commercial_financial_terms');
    expect(JSON.stringify(content[1])).toContain('dynamic-correlation');
    expect(content[1]).not.toHaveProperty('cache_control');
  });

  it('keeps the existing Anthropic single-block prompt shape when prompt cache is disabled', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'agent.tender.deep_analysis.section',
        instructions: 'Return JSON.',
        cacheablePrefix: 'stable tender evidence scope',
        promptCache: { enabled: false, ttl: '1h' },
        input: { sectionKey: 'commercial_financial_terms' },
      }),
    ).resolves.toMatchObject({ output: { status: 'completed' } });

    const messages = requestBody?.messages as Array<{ content?: unknown }> | undefined;
    const content = messages?.[0]?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]?.cache_control).toBeUndefined();
    expect(JSON.stringify(content)).not.toContain('stable tender evidence scope');
  });

  it.each([
    ['raw JSON', '{"status":"completed"}'],
    ['markdown-fenced JSON', '```json\n{"status":"completed"}\n```'],
    [
      'prose with markdown-fenced JSON',
      'Here is the JSON:\n```json\n{"status":"completed"}\n```',
    ],
  ])('parses Anthropic text content as %s', async (_label, text) => {
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      model.generateJson({
        taskType: 'task.anthropic_json_shape',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).resolves.toMatchObject({ output: { status: 'completed' } });
  });

  it('rejects malformed Anthropic JSON text content', async () => {
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      maxRetries: 1,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      model.generateJson({
        taskType: 'task.anthropic_malformed_json',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).rejects.toThrow(
      'Anthropic task.anthropic_malformed_json failed after 1 attempts',
    );
  });

  it('rejects non-object Anthropic JSON text content', async () => {
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      maxRetries: 1,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '["completed"]' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      model.generateJson({
        taskType: 'task.anthropic_non_object_json',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).rejects.toThrow('Structured task model output must be a JSON object.');
  });

  it('retries transient Anthropic overload responses before succeeding', async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'Overloaded' } }),
          { status: 529, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"status":"completed"}' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      fetchImpl: fetchMock,
    });

    await expect(
      model.generateJson({
        taskType: 'task.overloaded',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).resolves.toMatchObject({ output: { status: 'completed' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient Anthropic validation failures', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Bad request' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      maxRetries: 3,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      fetchImpl: fetchMock,
    });

    await expect(
      model.generateJson({
        taskType: 'task.bad_request',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).rejects.toThrow('Anthropic task.bad_request failed after 3 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('estimates generic Anthropic token usage when provider usage is missing', async () => {
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      model.generateJson({
        taskType: 'task.estimated',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).resolves.toMatchObject({
      output: { status: 'completed' },
      modelUsage: {
        provider: 'anthropic',
        model: 'claude-test',
        taskType: 'task.estimated',
        usageSource: 'estimated',
      },
    });
  });

  it('applies Anthropic task policies to model, effort, and max tokens', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-default',
      maxTokens: 4096,
      taskPolicies: {
        'task.expensive': {
          model: 'claude-sonnet-task',
          effort: 'low',
          maxTokens: 1234,
        },
      },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              cache_read_input_tokens: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'task.expensive',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).resolves.toMatchObject({ output: { status: 'completed' } });

    expect(requestBody).toMatchObject({
      model: 'claude-sonnet-task',
      max_tokens: 1234,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
  });

  it('omits Anthropic effort fields when a task policy sets effort off', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-default',
      taskPolicies: {
        'task.cheap': {
          model: 'claude-haiku-task',
          effort: 'off',
          maxTokens: 512,
        },
      },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              cache_read_input_tokens: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'task.cheap',
        instructions: 'Return JSON.',
        input: { value: 1 },
      }),
    ).resolves.toMatchObject({ output: { status: 'completed' } });

    expect(requestBody).toMatchObject({
      model: 'claude-haiku-task',
      max_tokens: 512,
    });
    expect(requestBody).not.toHaveProperty('thinking');
    expect(requestBody).not.toHaveProperty('output_config');
  });

  it('sends Anthropic structured task image attachments as vision blocks', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const model = createAnthropicStructuredModelProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"status":"completed"}' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      model.generateJson({
        taskType: 'task.vision',
        instructions: 'Return JSON.',
        input: { value: 1 },
        attachments: [
          {
            label: 'captcha',
            mimeType: 'image/png',
            base64: 'base64-image',
            purpose: 'captcha_ocr',
          },
        ],
      }),
    ).resolves.toMatchObject({ output: { status: 'completed' } });
    const messages = requestBody?.messages;
    expect(Array.isArray(messages)).toBe(true);
    const firstMessage = (messages as Array<{ content?: unknown }>)[0];
    expect(firstMessage.content).toContainEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'base64-image',
      },
    });
  });

  it('fetches and summarizes HTTP pages with blocking signals', async () => {
    const provider = createHttpFetchProvider({
      fetchImpl: async () =>
        new Response(
          '<html><title>Portal</title><body>Please login to continue</body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          },
        ),
    });

    await expect(
      provider.fetch({ url: 'https://example.gov' }),
    ).resolves.toMatchObject({
      title: 'Portal',
      blockedReason: 'login_required',
      provider: 'http-fetch',
    });
  });

  it('maps Firecrawl scrape responses into structured fetch results', async () => {
    const provider = createFirecrawlFetchProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              markdown: 'Public resource notices',
              metadata: {
                sourceURL: 'https://example.gov',
                title: 'Procurement Portal',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.fetch({ url: 'https://example.gov' }),
    ).resolves.toMatchObject({
      url: 'https://example.gov',
      title: 'Procurement Portal',
      text: 'Public resource notices',
      provider: 'firecrawl-scrape',
    });
  });

  it('maps Firecrawl crawl responses into structured crawl pages', async () => {
    const provider = createFirecrawlCrawlProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                markdown: 'Resource page',
                metadata: {
                  sourceURL: 'https://example.gov/Resources',
                  title: 'Resources',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      provider.crawl({ url: 'https://example.gov', limit: 1 }),
    ).resolves.toMatchObject({
      startUrl: 'https://example.gov',
      provider: 'firecrawl',
      pages: [
        {
          url: 'https://example.gov/Resources',
          title: 'Resources',
          text: 'Resource page',
        },
      ],
    });
  });

  it('fails search provider construction clearly when the Tavily key is missing', () => {
    expect(() => createTavilySearchProvider({ apiKey: '' })).toThrow(
      'TAVILY_API_KEY',
    );
  });

  it('fails Firecrawl provider construction clearly when the Firecrawl key is missing', () => {
    expect(() => createFirecrawlSearchProvider({ apiKey: '' })).toThrow(
      'FIRECRAWL_API_KEY',
    );
    expect(() => createFirecrawlFetchProvider({ apiKey: '' })).toThrow(
      'FIRECRAWL_API_KEY',
    );
    expect(() => createFirecrawlCrawlProvider({ apiKey: '' })).toThrow(
      'FIRECRAWL_API_KEY',
    );
  });

  it('signs and verifies external event requests', () => {
    const input = {
      secret: 'secret',
      method: 'post',
      path: '/v1/integrations/platform-events',
      timestamp: '1000',
      nonce: 'nonce',
      rawBody: '{"ok":true}',
    };
    const signature = signExternalEventRequest(input);
    expect(
      verifyExternalEventSignature({ ...input, signature, nowMs: 1000 }),
    ).toBe(true);
    expect(
      verifyExternalEventSignature({ ...input, signature: 'bad', nowMs: 1000 }),
    ).toBe(false);
  });

  it('verifies webhook signatures', () => {
    const secret = 'secret';
    const timestamp = '1000';
    const eventId = 'evt_1';
    const eventType = 'delivery.status';
    const rawBody = '{"ok":true}';
    const signature = cryptoSign(
      secret,
      `${timestamp}.${eventId}.${eventType}.${rawBody}`,
    );
    expect(
      verifyWebhookSignature({
        secret,
        timestamp,
        eventId,
        eventType,
        rawBody,
        signature,
        nowMs: 1000,
      }),
    ).toBe(true);
  });

  it('renders signed Teams submit actions for embedded notification cards', () => {
    const card = buildExternalNotificationAdaptiveCard({
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      actionSecret: 'secret',
      nowMs: 1000,
      payload: {
        subjectId: 'subject-1',
        notificationCard: {
          schemaVersion: 'external.notification.card.v1',
          renderer: 'gantry_adaptive_card',
          title: 'Resource',
          scopeId: 'scope-1',
          sourceConversationId: '19:conversation',
          teamsTenantId: 'tenant-1',
          actions: [
            {
              actionType: 'track_subject',
              label: 'Watch',
              presentation: 'submit',
              platformOperation: 'mark_resource',
            },
          ],
        },
      },
    });

    const action = (card?.actions as Array<{ data: unknown }>)[0]?.data;
    const parsed = parseExternalCardAction(action);
    expect(parsed).toMatchObject({
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'scope-1',
      sourceScopeId: 'scope-1',
      sourceConversationId: '19:conversation',
      teamsTenantId: 'tenant-1',
      actionType: 'track_subject',
      platformOperation: 'mark_resource',
    });
    expect(
      parsed &&
        verifyExternalCardAction({
          action: parsed,
          secret: 'secret',
          nowMs: 1000,
        }),
    ).toBe(true);
  });

  it('signs v2 card actions with operation and request context', () => {
    const signed = signExternalCardAction({
      secret: 'secret',
      signatureVersion: 'v2',
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-review-1',
      requestId: 'request-1',
      subjectId: 'resource-1',
      scopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'approve_request',
      platformOperation: 'approveRequest',
      nowMs: 1000,
    });
    const action = parseExternalCardAction({
      action: 'external_card_action',
      signatureVersion: signed.signatureVersion,
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-review-1',
      requestId: 'request-1',
      subjectId: 'resource-1',
      scopeId: 'workspace-1',
      sourcescopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'approve_request',
      platformOperation: 'approveRequest',
      nonce: signed.nonce,
      expiresAt: signed.expiresAt,
      signature: signed.signature,
    });

    expect(action).toMatchObject({
      signatureVersion: 'v2',
      requestId: 'request-1',
      platformOperation: 'approveRequest',
    });
    expect(
      action &&
        verifyExternalCardAction({ action, secret: 'secret', nowMs: 1000 }),
    ).toBe(true);
    expect(
      action &&
        verifyExternalCardAction({
          action: {
            ...action,
            platformOperation: 'rejectRequest',
          },
          secret: 'secret',
          nowMs: 1000,
        }),
    ).toBe(false);
  });

  it('verifies card actions when Teams rewrites equivalent expiresAt strings', () => {
    const baseAction = {
      action: 'external_card_action',
      signatureVersion: 'v2' as const,
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'workspace-1',
      sourcescopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'request_review',
      platformOperation: 'requestReviewApproval',
    };
    const signedWithMilliseconds = signExternalCardAction({
      secret: 'secret',
      ...baseAction,
      expiresAt: '2099-01-01T00:00:00.550Z',
      nonce: 'nonce-550',
    });
    const shortenedMillisecondsAction = parseExternalCardAction({
      ...baseAction,
      nonce: signedWithMilliseconds.nonce,
      expiresAt: '2099-01-01T00:00:00.55Z',
      signature: signedWithMilliseconds.signature,
    });

    expect(shortenedMillisecondsAction).toMatchObject({
      expiresAt: '2099-01-01T00:00:00.550Z',
    });
    expect(
      shortenedMillisecondsAction &&
        verifyExternalCardAction({
          action: shortenedMillisecondsAction,
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(true);

    const signedWithZeroMilliseconds = signExternalCardAction({
      secret: 'secret',
      ...baseAction,
      expiresAt: '2099-01-01T00:00:00.000Z',
      nonce: 'nonce-000',
    });
    const omittedZeroMillisecondsAction = parseExternalCardAction({
      ...baseAction,
      nonce: signedWithZeroMilliseconds.nonce,
      expiresAt: '2099-01-01T00:00:00Z',
      signature: signedWithZeroMilliseconds.signature,
    });

    expect(omittedZeroMillisecondsAction).toMatchObject({
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(
      omittedZeroMillisecondsAction &&
        verifyExternalCardAction({
          action: omittedZeroMillisecondsAction,
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(true);
  });

  it('keeps card action signatures strict after expiresAt normalization', () => {
    const signed = signExternalCardAction({
      secret: 'secret',
      signatureVersion: 'v2',
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'request_review',
      platformOperation: 'requestReviewApproval',
      nonce: 'nonce-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const action = parseExternalCardAction({
      action: 'external_card_action',
      signatureVersion: signed.signatureVersion,
      integrationId: 'external-workflow-bot',
      eventId: 'outbox-1',
      subjectId: 'subject-1',
      scopeId: 'workspace-1',
      sourceConversationId: '19:workspace',
      teamsTenantId: 'tenant-1',
      actionType: 'request_review',
      platformOperation: 'requestReviewApproval',
      nonce: signed.nonce,
      expiresAt: '2099-01-01T00:00:00Z',
      signature: signed.signature,
    });

    expect(
      action &&
        verifyExternalCardAction({
          action: { ...action, platformOperation: 'trackSubject' },
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(false);
    expect(
      action &&
        verifyExternalCardAction({
          action: { ...action, subjectId: 'subject-2' },
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(false);
    expect(
      action &&
        verifyExternalCardAction({
          action: { ...action, nonce: 'nonce-2' },
          secret: 'secret',
          nowMs: Date.parse('2026-05-27T00:00:00Z'),
        }),
    ).toBe(false);
    expect(() =>
      signExternalCardAction({
        secret: 'secret',
        signatureVersion: 'v2',
        integrationId: 'external-workflow-bot',
        eventId: 'outbox-1',
        subjectId: 'subject-1',
        scopeId: 'workspace-1',
        sourceConversationId: '19:workspace',
        teamsTenantId: 'tenant-1',
        actionType: 'request_review',
        platformOperation: 'requestReviewApproval',
        expiresAt: 'not-a-date',
      }),
    ).toThrow('External card action expiration timestamp is invalid.');
  });

  it('sends notification card requests through the external platform event route', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> =
      [];
    const client = createGantryClient({
      baseUrl: 'http://gantry.test',
      eventSecret: 'secret',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202,
        });
      },
    });

    const result = await client.notifications.sendCard({
      integrationId: 'external-workflow-bot',
      eventId: 'evt_1',
      occurredAt: '2026-05-24T00:00:00.000Z',
      target: { teamsChannelId: 'channel', scopeId: 'workspace' },
      payload: { subjectId: 'subject-1' },
    });

    expect(result.statusCode).toBe(202);
    expect(calls[0]?.url).toBe(
      'http://gantry.test/v1/integrations/platform-events',
    );
    expect(
      (calls[0]?.init.headers as Record<string, string>)[
        'x-gantry-external-event-signature'
      ],
    ).toBeTruthy();
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      eventType: 'notification.card.requested',
      target: { teamsChannelId: 'channel' },
    });
  });

  it('sends Teams thread replies through the control route', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> =
      [];
    const client = createGantryClient({
      baseUrl: 'http://gantry.test',
      apiKey: 'key',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202,
        });
      },
    });

    await client.teams.sendThreadReply({
      conversationId: 'conversation',
      replyToId: 'message',
      text: 'hello',
    });

    expect(calls[0]?.url).toBe(
      'http://gantry.test/v1/providers/teams/thread-replies',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      conversationId: 'conversation',
      replyToId: 'message',
      text: 'hello',
    });
  });

  it('accepts minimal Response-like fetch mocks', async () => {
    const client = createGantryClient({
      baseUrl: 'http://gantry.test',
      eventSecret: 'secret',
      fetchImpl: async () => ({ ok: true, status: 202 }) as Response,
    });

    await expect(
      client.notifications.sendEvent({
        integrationId: 'external-workflow-bot',
        eventId: 'evt_1',
        eventType: 'resource_processing_failed',
        occurredAt: '2026-05-24T00:00:00.000Z',
        payload: { subjectId: 'subject_1' },
      }),
    ).resolves.toMatchObject({ statusCode: 202 });
  });

  it('creates an embedded runtime without a control base URL', async () => {
    const messages: unknown[] = [];
    const runtime = createGantryRuntime({
      storage: {
        recordMessage: (input) => messages.push(input),
      },
      teams: {
        sendCard: () => ({ accepted: true, statusCode: 202 }),
        sendDm: () => ({ accepted: true, statusCode: 202 }),
        sendThreadReply: () => ({ accepted: true, statusCode: 202 }),
      },
      tasks: {
        runStructuredTask: async () => ({
          status: 'completed',
          output: { ok: true },
        }),
      },
    });

    await expect(
      runtime.teams.sendCard({
        conversationId: 'conversation',
        card: { type: 'AdaptiveCard' },
      }),
    ).resolves.toMatchObject({ statusCode: 202 });
    await expect(
      runtime.tasks.runStructuredTask({
        taskType: 'test',
        instructions: 'return ok',
        input: {},
      }),
    ).resolves.toMatchObject({ output: { ok: true } });
    await expect(
      runtime.teams.handleIncomingActivity({
        activity: {
          type: 'message',
          id: 'message',
          text: 'hello',
          conversation: { id: 'conversation' },
          from: { aadObjectId: 'user', name: 'User' },
          channelData: { tenant: { id: 'tenant' } },
        },
      }),
    ).resolves.toMatchObject({
      messageId: 'message',
      conversationId: 'conversation',
      teamsUserId: 'user',
    });
    expect(messages).toHaveLength(1);
  });

  it('normalizes Teams message.value card submits without requiring invoke activities', async () => {
    const actionValue = { action: 'external_card_action', eventId: 'outbox-1' };
    const runtime = createGantryRuntime({
      teams: {
        sendCard: () => ({ accepted: true, statusCode: 202 }),
        sendDm: () => ({ accepted: true, statusCode: 202 }),
        sendThreadReply: () => ({ accepted: true, statusCode: 202 }),
      },
    });

    await expect(
      runtime.teams.handleIncomingActivity({
        activity: {
          type: 'message',
          id: 'message-action-1',
          value: actionValue,
          conversation: { id: '19:workspace' },
          from: { aadObjectId: 'teams-user-1' },
          channelData: { tenant: { id: 'tenant-1' } },
        },
      }),
    ).resolves.toMatchObject({
      type: 'message',
      messageId: 'message-action-1',
      conversationId: '19:workspace',
      value: actionValue,
      teamsTenantId: 'tenant-1',
      teamsUserId: 'teams-user-1',
    });
  });

  it('stores Teams channel conversation references under the base channel id', async () => {
    const savedReferences: unknown[] = [];
    const activity = {
      type: 'message',
      id: 'message-action-1',
      serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
      conversation: {
        id: '19:channel@thread.tacv2;messageid=parent-card-1',
        isGroup: true,
        conversationType: 'channel',
      },
      from: { aadObjectId: 'teams-user-1', id: '29:user', name: 'User' },
      recipient: { id: '28:bot', name: 'Workflow Bot' },
      channelData: {
        channel: { id: '19:channel@thread.tacv2' },
        tenant: { id: 'tenant-1' },
      },
    };
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async (_req, _res, logic) => {
        await logic({ activity } as never);
      },
      continueConversation: async () => undefined,
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {
        saveTeamsConversationReference: (reference) =>
          savedReferences.push(reference),
      },
      adapter,
    });
    const seenActivities: unknown[] = [];

    await transport.handleHttpActivity?.({
      req: {} as never,
      res: {
        writableEnded: false,
        end: () => undefined,
        setHeader: () => undefined,
      } as never,
      onActivity: (incoming) => seenActivities.push(incoming),
    });

    expect(savedReferences[0]).toMatchObject({
      exists: true,
      conversationId: '19:channel@thread.tacv2',
      conversationJid: 'teams:19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
      tenantId: 'tenant-1',
      botId: '28:bot',
      teamsUserId: 'teams-user-1',
    });
    expect(seenActivities[0]).toMatchObject({
      conversationId: '19:channel@thread.tacv2;messageid=parent-card-1',
    });
  });

  it('finds historical Teams references stored with message-scoped conversation ids', async () => {
    const storage = createPgGantryRuntimeStorage({
      schema: 'gantry_runtime',
      pool: {
        query: async (_sql, values) => {
          expect(values).toEqual([
            'teams:19:channel@thread.tacv2',
            'teams:19:channel@thread.tacv2',
            '19:channel@thread.tacv2',
            '19:channel@thread.tacv2',
          ]);
          return {
            rows: [
              {
                conversation_jid:
                  'teams:19:channel@thread.tacv2;messageid=parent-card-1',
                conversation_id:
                  '19:channel@thread.tacv2;messageid=parent-card-1',
                service_url: 'https://smba.trafficmanager.net/in/tenant-1/',
                tenant_id: 'tenant-1',
                bot_id: '28:bot',
                teams_user_id: 'teams-user-1',
                raw_reference_json: JSON.stringify({
                  serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
                  conversation: {
                    id: '19:channel@thread.tacv2;messageid=parent-card-1',
                  },
                }),
                updated_at: new Date('2026-06-05T13:29:56.000Z'),
              },
            ],
          };
        },
      },
    });

    await expect(
      storage.getTeamsConversationReference?.('19:channel@thread.tacv2'),
    ).resolves.toMatchObject({
      exists: true,
      conversationId: '19:channel@thread.tacv2;messageid=parent-card-1',
      conversationJid: 'teams:19:channel@thread.tacv2;messageid=parent-card-1',
      tenantId: 'tenant-1',
      rawReferenceJson: expect.stringContaining('parent-card-1'),
    });
  });

  it('sends Teams cards through embedded Bot Framework transport', async () => {
    const sent: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (_reference, logic) => {
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: 'teams-message-1' };
          },
        } as never);
      },
    };
    const storage = {
      getTeamsConversationReference: () => ({
        exists: true,
        conversationId: 'conversation',
        conversationJid: 'teams:conversation',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        rawReferenceJson: JSON.stringify({
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          conversation: { id: 'conversation' },
        }),
      }),
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage,
      adapter,
    });

    await expect(
      transport.sendCard({
        conversationId: 'conversation',
        card: { type: 'AdaptiveCard' },
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    expect(sent).toHaveLength(1);
  });

  it('rejects Teams card sends when Bot Framework returns no provider message id', async () => {
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (_reference, logic) => {
        await logic({
          sendActivity: async () => undefined,
        } as never);
      },
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {
        getTeamsConversationReference: () => ({
          exists: true,
          conversationId: 'conversation',
          conversationJid: 'teams:conversation',
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.trafficmanager.net/emea/',
            conversation: { id: 'conversation' },
          }),
        }),
      },
      adapter,
    });

    await expect(
      transport.sendCard({
        conversationId: 'conversation',
        card: { type: 'AdaptiveCard' },
      }),
    ).rejects.toThrow(
      'Teams delivery did not return a provider message id for conversation conversation.',
    );
  });

  it('sends Teams cards to the base channel when the stored reference is message-scoped', async () => {
    const sent: unknown[] = [];
    const references: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (reference, logic) => {
        references.push(reference);
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: 'teams-message-1' };
          },
        } as never);
      },
    };
    const storage = {
      getTeamsConversationReference: (conversationId: string) => {
        expect(conversationId).toBe('19:channel@thread.tacv2');
        return {
          exists: true,
          conversationId: '19:channel@thread.tacv2;messageid=parent-card-1',
          conversationJid:
            'teams:19:channel@thread.tacv2;messageid=parent-card-1',
          serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.trafficmanager.net/in/tenant-1/',
            conversation: {
              id: '19:channel@thread.tacv2;messageid=parent-card-1',
            },
          }),
        };
      },
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage,
      adapter,
    });

    await expect(
      transport.sendCard({
        conversationId: '19:channel@thread.tacv2',
        card: { type: 'AdaptiveCard' },
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });

    expect(references).toEqual([
      expect.objectContaining({
        conversation: { id: '19:channel@thread.tacv2' },
      }),
    ]);
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'message',
        attachments: [
          expect.objectContaining({ content: { type: 'AdaptiveCard' } }),
        ],
      }),
    ]);
  });

  it('sends Teams thread replies with a thread-scoped conversation reference', async () => {
    const sent: unknown[] = [];
    const references: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (reference, logic) => {
        references.push(reference);
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: 'teams-reply-1' };
          },
        } as never);
      },
    };
    const lookedUp: string[] = [];
    const storage = {
      getTeamsConversationReference: (conversationId: string) => {
        lookedUp.push(conversationId);
        return {
          exists: true,
          conversationId,
          conversationJid: `teams:${conversationId}`,
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.trafficmanager.net/emea/',
            conversation: { id: conversationId },
          }),
        };
      },
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage,
      adapter,
    });

    await expect(
      transport.sendThreadReply({
        conversationId: '19:channel',
        replyToId: 'parent-message',
        text: 'hello',
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    await expect(
      transport.sendThreadReply({
        conversationId: '19:channel;messageid=parent-message',
        replyToId: 'parent-message',
        text: 'again',
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });

    expect(lookedUp).toEqual(['19:channel', '19:channel']);
    expect(references).toEqual([
      expect.objectContaining({
        conversation: { id: '19:channel;messageid=parent-message' },
      }),
      expect.objectContaining({
        conversation: { id: '19:channel;messageid=parent-message' },
      }),
    ]);
    expect(sent).toEqual([
      expect.objectContaining({ replyToId: 'parent-message', text: 'hello' }),
      expect.objectContaining({ replyToId: 'parent-message', text: 'again' }),
    ]);
  });

  it('rejects Teams thread replies when Bot Framework returns no provider message id', async () => {
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {
        getTeamsConversationReference: (conversationId: string) => ({
          exists: true,
          conversationId,
          conversationJid: `teams:${conversationId}`,
          serviceUrl: 'https://smba.trafficmanager.net/emea/',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.trafficmanager.net/emea/',
            conversation: { id: conversationId },
          }),
        }),
      },
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async (_reference, logic) => {
          await logic({
            sendActivity: async () => undefined,
          } as never);
        },
      },
    });

    await expect(
      transport.sendThreadReply({
        conversationId: '19:channel',
        replyToId: 'parent-message',
        text: 'hello',
      }),
    ).rejects.toThrow(
      'Teams delivery did not return a provider message id for conversation 19:channel;messageid=parent-message.',
    );
  });

  it('returns a stable missing-reference result for Teams DMs', async () => {
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {},
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async () => undefined,
      },
    });

    await expect(
      transport.sendDm({
        teamsUserId: 'user',
        text: 'hello',
      }),
    ).resolves.toMatchObject({
      accepted: false,
      statusCode: 409,
      body: { code: 'teams_personal_conversation_reference_missing' },
    });
  });

  it('creates a personal Teams conversation when only a channel reference is known', async () => {
    const sent: string[] = [];
    let createdConversation = false;
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {
        getTeamsPersonalConversationReference: () => ({
          exists: true,
          conversationId: '19:channel-thread',
          conversationJid: 'teams:19:channel-thread',
          serviceUrl: 'https://smba.test/',
          tenantId: 'tenant-1',
          teamsUserId: 'user-1',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.test/',
            user: { id: '29:user', aadObjectId: 'user-1' },
            bot: { id: '28:bot' },
            conversation: {
              id: '19:channel-thread',
              conversationType: 'channel',
              isGroup: true,
              tenantId: 'tenant-1',
            },
          }),
        }),
      },
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async () => {
          throw new Error('should create a personal conversation first');
        },
        createConversation: async (
          _reference: unknown,
          parameters: { readonly isGroup?: boolean },
          logic: (context: {
            sendActivity(activity: { text?: string }): Promise<{ id: string }>;
          }) => Promise<void>,
        ) => {
          createdConversation = parameters.isGroup === false;
          await logic({
            sendActivity: async (activity) => {
              sent.push(activity.text ?? '');
              return { id: 'dm-message-1' };
            },
          });
        },
      },
    });

    await expect(
      transport.sendDm({
        teamsUserId: 'user-1',
        teamsTenantId: 'tenant-1',
        text: 'hello',
      }),
    ).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    expect(createdConversation).toBe(true);
    expect(sent).toEqual(['hello']);
  });

  it('rejects Teams DMs when Bot Framework returns no provider message id', async () => {
    const transport = createBotFrameworkTeamsTransport({
      botAppId: 'bot',
      botAppPassword: 'secret',
      storage: {
        getTeamsPersonalConversationReference: () => ({
          exists: true,
          conversationId: '19:channel-thread',
          conversationJid: 'teams:19:channel-thread',
          serviceUrl: 'https://smba.test/',
          tenantId: 'tenant-1',
          teamsUserId: 'user-1',
          rawReferenceJson: JSON.stringify({
            serviceUrl: 'https://smba.test/',
            user: { id: '29:user', aadObjectId: 'user-1' },
            bot: { id: '28:bot' },
            conversation: {
              id: '19:channel-thread',
              conversationType: 'channel',
              isGroup: true,
              tenantId: 'tenant-1',
            },
          }),
        }),
      },
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async () => {
          throw new Error('should create a personal conversation first');
        },
        createConversation: async (_reference, _parameters, logic) => {
          await logic({
            sendActivity: async () => undefined,
          } as never);
        },
      },
    });

    await expect(
      transport.sendDm({
        teamsUserId: 'user-1',
        teamsTenantId: 'tenant-1',
        text: 'hello',
      }),
    ).rejects.toThrow(
      'Teams delivery did not return a provider message id for conversation 19:channel-thread.',
    );
  });

  it('creates pg-backed runtime storage using the Gantry schema', async () => {
    const calls: unknown[][] = [];
    const storage = createPgGantryRuntimeStorage({
      pool: {
        query: async (...args: unknown[]) => {
          calls.push(args);
          return { rows: [] };
        },
      },
    });

    await storage.recordMessage?.({
      provider: 'teams',
      conversationId: 'conversation',
      messageId: 'message',
      occurredAt: '2026-05-25T00:00:00.000Z',
    });
    expect(String(calls[0]?.[0])).toContain(
      '"gantry_runtime"."runtime_messages"',
    );
  });

  it('creates, reads, and merges pg-backed user conversation state by full scope key', async () => {
    const calls: unknown[][] = [];
    const storage = createPgGantryRuntimeStorage({
      pool: {
        query: async (...args: unknown[]) => {
          calls.push(args);
          return {
            rows: [
              {
                provider: 'teams',
                tenant_id: 'tenant-1',
                user_id: 'user-1',
                conversation_id: 'conversation-1',
                conversation_scope_type: 'teams_thread',
                conversation_scope_id: 'reply-1',
                summary_text: 'Safe UX summary',
                state_json: { last_intent: 'document_qa' },
                last_subject_id: 'subject-1',
                last_seen_at: new Date('2026-06-01T00:00:00.000Z'),
                expires_at: new Date('2026-07-01T00:00:00.000Z'),
                created_at: new Date('2026-06-01T00:00:00.000Z'),
                updated_at: new Date('2026-06-01T00:00:00.000Z'),
              },
            ],
          };
        },
      },
    });
    const key = {
      provider: 'teams',
      tenantId: 'tenant-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      conversationScopeType: 'teams_thread',
      conversationScopeId: 'reply-1',
    };

    await expect(
      storage.upsertUserConversationState?.({
        ...key,
        summaryText: 'Safe UX summary',
        stateJson: { last_intent: 'document_qa' },
        lastSubjectId: 'subject-1',
        lastSeenAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      ...key,
      summaryText: 'Safe UX summary',
      stateJson: { last_intent: 'document_qa' },
    });
    await storage.getUserConversationState?.(key);
    await storage.mergeUserConversationState?.({
      ...key,
      summaryText: 'Safe follow-up',
      stateJson: { last_answered: true },
      lastSeenAt: '2026-06-01T00:01:00.000Z',
      expiresAt: '2026-07-01T00:01:00.000Z',
    });

    expect(String(calls[0]?.[0])).toContain(
      '"gantry_runtime"."user_conversation_state"',
    );
    expect((calls[0]?.[1] as unknown[] | undefined)?.[7]).toEqual({
      last_intent: 'document_qa',
    });
    expect(String(calls[1]?.[0])).toContain('expires_at > now()');
    expect(String(calls[2]?.[0])).toContain('state_json');
    expect(String(calls[2]?.[0])).toContain('jsonb_typeof');
    expect((calls[2]?.[1] as unknown[] | undefined)?.[7]).toEqual({
      last_answered: true,
    });
    expect(calls[1]?.[1]).toEqual([
      'teams',
      'tenant-1',
      'user-1',
      'conversation-1',
      'teams_thread',
      'reply-1',
    ]);
  });

  it('normalizes legacy pg-backed conversation state JSON shapes on read', async () => {
    const storage = createPgGantryRuntimeStorage({
      pool: {
        query: async () => ({
          rows: [
            {
              provider: 'teams',
              tenant_id: 'tenant-1',
              user_id: 'user-1',
              conversation_id: 'conversation-1',
              conversation_scope_type: 'teams_thread',
              conversation_scope_id: 'reply-1',
              summary_text: 'Safe UX summary',
              state_json: [
                '{"last_intent":"older"}',
                '{"last_intent":"document_qa","last_answered":true}',
              ],
              last_subject_id: 'subject-1',
              last_seen_at: '2026-06-01T00:00:00.000Z',
              expires_at: '2026-07-01T00:00:00.000Z',
              created_at: '2026-06-01T00:00:00.000Z',
              updated_at: '2026-06-01T00:00:00.000Z',
            },
          ],
        }),
      },
    });

    await expect(
      storage.getUserConversationState?.({
        provider: 'teams',
        tenantId: 'tenant-1',
        userId: 'user-1',
        conversationId: 'conversation-1',
        conversationScopeType: 'teams_thread',
        conversationScopeId: 'reply-1',
      }),
    ).resolves.toMatchObject({
      stateJson: { last_intent: 'document_qa', last_answered: true },
      lastSubjectId: 'subject-1',
    });
  });

  it('runs structured model tasks and records audit state', async () => {
    const audits: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () => ({
          recipeSnapshotJson: { steps: [] },
          validationReportJson: { valid: true },
        }),
      },
      storage: {
        recordStructuredTaskRun: (input) => audits.push(input),
      },
    });

    await expect(
      runner.runStructuredTask({
        taskType: 'recipe',
        instructions: 'return a recipe',
        input: { websiteId: 'website' },
        correlationId: 'website',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: { recipeSnapshotJson: { steps: [] } },
    });
    expect(audits).toHaveLength(1);
  });

  it('keeps successful structured tool evidence when sibling tools abort', async () => {
    const runner = createStructuredModelTaskRunner({
      tools: {
        search: {
          search: async () => ({
            provider: 'firecrawl-search',
            items: [
              {
                url: 'https://example.gov/Resources',
                title: 'Resource portal',
                snippet: 'Open bid notices',
              },
            ],
          }),
        },
        fetch: {
          fetch: async () => {
            throw new Error('This operation was aborted');
          },
        },
        crawl: {
          crawl: async () => {
            throw new Error('This operation was aborted');
          },
        },
      },
      model: {
        generateJson: async (input) => {
          const toolContext = input.input.toolContext as {
            search?: Array<{
              items?: Array<{ title?: unknown; url?: unknown }>;
            }>;
          };
          const firstItem = toolContext.search?.[0]?.items?.[0] ?? {};
          return {
            candidatesJson: [
              {
                url: firstItem.url,
                title: firstItem.title,
                confidence: 0.8,
              },
            ],
          };
        },
      },
    });

    await expect(
      runner.runStructuredTask({
        taskType: 'source_discovery',
        instructions: 'find resource sources',
        input: {
          toolRequests: {
            search: [{ query: 'state Resource portal', limit: 1 }],
            fetch: [{ url: 'https://example.gov/Resources' }],
            crawl: [{ url: 'https://example.gov/Resources' }],
          },
        },
        correlationId: 'source-discovery',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        candidatesJson: [
          {
            url: 'https://example.gov/Resources',
            title: 'Resource portal',
            confidence: 0.8,
          },
        ],
        toolContext: {
          search: [
            {
              query: 'state Resource portal',
              provider: 'firecrawl-search',
              items: [
                {
                  url: 'https://example.gov/Resources',
                  title: 'Resource portal',
                },
              ],
            },
          ],
          fetch: [
            {
              requestedUrl: 'https://example.gov/Resources',
              toolFailure: true,
              error: 'This operation was aborted',
            },
          ],
          crawl: [
            {
              requestedUrl: 'https://example.gov/Resources',
              toolFailure: true,
              error: 'This operation was aborted',
            },
          ],
        },
      },
    });
  });

  it('runs generic agent tasks through tool calls until final output', async () => {
    const calls: unknown[] = [];
    const stepEvents: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          calls.push(input);
          if (calls.length === 1) {
            return {
              action: 'call_tool',
              toolName: 'set_value',
              input: { value: 'ready' },
              auditNote: 'Recording the value observed from the tool.',
              whyThisStep: 'The task is incomplete until the value is stored.',
              expectedOutcome: 'The setter returns a completed observation.',
              nextIfFails: 'Retry with the corrected setter payload.',
            };
          }
          return {
            action: 'final',
            output: { status: 'done', value: 'ready' },
            auditNote: 'The required value is now available.',
          };
        },
      },
    });

    await expect(
      runner.runAgentTask?.({
        taskType: 'generic.test',
        instructions: 'Use tools until done.',
        input: {},
        tools: [
          {
            name: 'set_value',
            execute: (input) => ({ status: 'completed', value: input.value }),
          },
        ],
        correlationId: 'agent-loop-test',
        maxSteps: 4,
        onStep: (step) => stepEvents.push(step),
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        value: 'ready',
      },
      steps: [
        { actionType: 'call_tool', toolName: 'set_value', status: 'completed' },
        { actionType: 'final', status: 'completed' },
      ],
    });
    expect(stepEvents).toHaveLength(2);
    expect(stepEvents[0]).toMatchObject({
      actionType: 'call_tool',
      actionInput: { value: 'ready' },
      auditNote: 'Recording the value observed from the tool.',
      whyThisStep: 'The task is incomplete until the value is stored.',
      expectedOutcome: 'The setter returns a completed observation.',
      nextIfFails: 'Retry with the corrected setter payload.',
      promptMetrics: expect.objectContaining({
        availableToolCount: 1,
        retainedObservationCount: 0,
      }),
    });
    expect(stepEvents[1]).toMatchObject({
      actionType: 'final',
      auditNote: 'The required value is now available.',
      promptMetrics: expect.objectContaining({
        retainedObservationCount: 1,
      }),
    });
  });

  it('keeps recovery guidance in the generic agent loop after repeated tool failures', async () => {
    const modelStates: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          modelStates.push(input.input);
          if (modelStates.length <= 2) {
            return {
              action: 'call_tool',
              toolName: 'set_value',
              input: { value: '' },
              auditNote: 'Trying to set the required value.',
            };
          }
          return {
            action: 'final',
            output: {
              status: 'needs_review',
              reason: 'tool did not accept empty value',
            },
          };
        },
      },
    });

    await expect(
      runner.runAgentTask?.({
        taskType: 'generic.recovery',
        instructions: 'Use tools until done.',
        input: {},
        tools: [
          {
            name: 'set_value',
            execute: () => ({ status: 'failed', error: 'value_required' }),
          },
        ],
        correlationId: 'agent-loop-recovery-test',
        maxSteps: 3,
      }),
    ).resolves.toMatchObject({
      status: 'needs_review',
      steps: [
        { actionType: 'call_tool', toolName: 'set_value', status: 'completed' },
        { actionType: 'call_tool', toolName: 'set_value', status: 'completed' },
        { actionType: 'final', status: 'completed' },
      ],
    });

    expect(modelStates[2]).toMatchObject({
      state: expect.objectContaining({
        recoveryHint: expect.objectContaining({
          repeatCount: 2,
          toolName: 'set_value',
          error: 'value_required',
        }),
        agentMemory: expect.objectContaining({
          failedActions: expect.arrayContaining([
            expect.objectContaining({
              toolName: 'set_value',
              reason: 'value_required',
            }),
          ]),
        }),
      }),
    });
  });

  it('preserves early durable agent memory after raw observations compact out', async () => {
    const modelStates: Array<Record<string, unknown>> = [];
    let modelStep = 0;
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          modelStep += 1;
          modelStates.push(input.input as Record<string, unknown>);
          if (modelStep <= 8) {
            return {
              action: 'call_tool',
              toolName: 'observe_page',
              input: { step: modelStep },
              previousGoalEvaluation: {
                goal: modelStep === 1 ? null : `observe page ${modelStep - 1}`,
                status: modelStep === 1 ? 'not_evaluated' : 'passed',
                evidenceRefs: [`snapshot-${modelStep - 1}`],
                reason: 'Recorded page evidence.',
              },
              memoryUpdate: {
                durableFacts:
                  modelStep === 1
                    ? { firstRouteProof: 'Latest Tenders route was found.' }
                    : { [`step${modelStep}Observed`]: true },
              },
              nextGoal: {
                goal: `observe page ${modelStep}`,
                requiredEvidence: ['page snapshot'],
                recommendedTool: 'observe_page',
              },
            };
          }
          return {
            action: 'final',
            output: { status: 'completed', value: 'done' },
            previousGoalEvaluation: {
              goal: 'observe page 8',
              status: 'passed',
              evidenceRefs: ['snapshot-8'],
              reason: 'All observations completed.',
            },
            memoryUpdate: { durableFacts: { finalReady: true } },
            nextGoal: {
              goal: 'finalize',
              requiredEvidence: [],
              recommendedTool: null,
            },
          };
        },
      },
    });

    await expect(
      runner.runAgentTask?.({
        taskType: 'generic.memory',
        instructions: 'Preserve durable memory while observing pages.',
        input: {},
        tools: [
          {
            name: 'observe_page',
            execute: (input) => ({
              status: 'completed',
              snapshot: {
                url: `https://example.test/page-${input.step}`,
                title: `Page ${input.step}`,
                snapshotId: `snapshot-${input.step}`,
              },
              screenshotRef: `browser-screenshot:file:/tmp/page-${input.step}.png`,
            }),
          },
        ],
        maxSteps: 10,
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    const finalModelState = modelStates[8]?.state as Record<string, unknown>;
    expect(finalModelState).toMatchObject({
      agentMemory: expect.objectContaining({
        durableFacts: expect.objectContaining({
          firstRouteProof: 'Latest Tenders route was found.',
        }),
      }),
      compactionSummary: expect.objectContaining({
        originalObservationCount: 8,
        retainedObservationCount: 6,
        droppedObservationCount: 2,
      }),
    });
  });

  it('compacts oversized observations into semantic summaries instead of first-only excerpts', () => {
    const summarized = summarizeAgentObservation({
      status: 'completed',
      snapshot: {
        url: 'https://example.test/tenders',
        title: 'Tender Listing',
        snapshotId: 'snapshot-large',
        visibleText: 'x'.repeat(9_000),
        interactive: [
          {
            ref: 'p1',
            snapshotId: 'snapshot-large',
            selector: 'button#moreTenders',
            text: 'More Tenders',
            onclick: 'clickForMoreTender()',
          },
          {
            ref: 'p2',
            snapshotId: 'snapshot-large',
            selector: 'a.page-2',
            text: '2',
            onclick: 'gotoPage(2)',
          },
        ],
        documentControls: [
          {
            ref: 'd1',
            snapshotId: 'snapshot-large',
            selector: 'button.download',
            text: 'Download NIT',
          },
        ],
        tables: [
          {
            tableIndex: 0,
            headers: ['Tender No', 'Title', 'Action'],
            rows: [
              {
                rowIndex: 1,
                cells: ['NIT-1', 'Road work', 'View'],
                actionRefs: [
                  {
                    ref: 'r1',
                    snapshotId: 'snapshot-large',
                    selector: 'button.view',
                    text: 'View Detail',
                  },
                ],
              },
            ],
          },
        ],
      },
      screenshotRef: 'browser-screenshot:file:/tmp/large.png',
    });

    expect(summarized).toMatchObject({
      compacted: true,
      semanticSummary: expect.objectContaining({
        currentPage: expect.objectContaining({
          url: 'https://example.test/tenders',
          title: 'Tender Listing',
          snapshotId: 'snapshot-large',
        }),
        evidenceRefs: expect.arrayContaining(['snapshot-large']),
        currentBrowserState: expect.objectContaining({
          actionCandidates: expect.arrayContaining([
            expect.objectContaining({
              type: 'pagination_action',
              text: 'More Tenders',
            }),
            expect.objectContaining({ type: 'pagination_action', text: '2' }),
            expect.objectContaining({
              type: 'document_action',
              text: 'Download NIT',
            }),
            expect.objectContaining({
              type: 'row_detail_action',
              text: 'View Detail',
            }),
            expect.objectContaining({ type: 'table_rows' }),
          ]),
        }),
      }),
    });
    expect(summarized).not.toHaveProperty('excerpt');
  });

  it('marks old screenshots as previous when a newer browser snapshot has no image', async () => {
    const modelStates: Array<Record<string, unknown>> = [];
    let modelStep = 0;
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          modelStep += 1;
          modelStates.push(input.input as Record<string, unknown>);
          if (modelStep === 1) {
            return {
              action: 'call_tool',
              toolName: 'browser_inspect',
              input: { mode: 'screenshot' },
              previousGoalEvaluation: {
                goal: null,
                status: 'not_evaluated',
                evidenceRefs: [],
                reason: 'Start.',
              },
              memoryUpdate: {},
              nextGoal: {
                goal: 'capture screenshot',
                requiredEvidence: ['screenshot'],
                recommendedTool: 'browser_inspect',
              },
            };
          }
          if (modelStep === 2) {
            return {
              action: 'call_tool',
              toolName: 'browser_inspect',
              input: { mode: 'snapshot' },
              previousGoalEvaluation: {
                goal: 'capture screenshot',
                status: 'passed',
                evidenceRefs: ['old-shot'],
                reason: 'Screenshot captured.',
              },
              memoryUpdate: {},
              nextGoal: {
                goal: 'inspect modal DOM',
                requiredEvidence: ['snapshot'],
                recommendedTool: 'browser_inspect',
              },
            };
          }
          return {
            action: 'final',
            output: { status: 'needs_review', reason: 'state captured' },
            previousGoalEvaluation: {
              goal: 'inspect modal DOM',
              status: 'passed',
              evidenceRefs: ['snapshot-modal'],
              reason: 'Snapshot captured.',
            },
            memoryUpdate: {},
            nextGoal: {
              goal: 'finish',
              requiredEvidence: [],
              recommendedTool: null,
            },
          };
        },
      },
    });
    const tools = createGantryBrowserGatewayAgentTools({
      status: () => ({ status: 'open' }),
      open: () => ({ status: 'open' }),
      inspect: (request) =>
        request.mode === 'screenshot'
          ? {
              status: 'completed',
              mode: 'screenshot',
              currentUrl: 'https://example.test/tenders',
              title: 'Tender Listing',
              screenshotRef: 'browser-screenshot:file:/tmp/old-listing.png',
            }
          : {
              status: 'completed',
              mode: 'snapshot',
              selectorEvidence: {
                modals: [
                  {
                    id: 'detail',
                    role: 'dialog',
                    open: true,
                    selector: '#detail',
                    text: 'Tender No 123 NIT document Download',
                  },
                ],
              },
              snapshot: {
                url: 'https://example.test/tenders',
                title: 'Tender Listing',
                snapshotId: 'snapshot-modal',
                visibleText: 'Tender listing with detail modal open',
                interactive: [
                  {
                    ref: 'p2',
                    snapshotId: 'snapshot-modal',
                    selector: 'a.page-2',
                    text: '2',
                    onclick: 'gotoPage(2)',
                  },
                ],
              },
            },
      act: () => ({ status: 'completed' }),
      close: () => ({ status: 'closed' }),
    });

    await expect(
      runner.runAgentTask?.({
        taskType: 'generic.browser-state',
        instructions: 'Track current browser state.',
        input: {},
        tools,
        maxSteps: 3,
      }),
    ).resolves.toMatchObject({ status: 'needs_review' });

    const thirdInputState = modelStates[2]?.state as Record<string, unknown>;
    expect(thirdInputState).toMatchObject({
      currentBrowserState: expect.objectContaining({
        snapshotId: 'snapshot-modal',
        screenshotRef: 'browser-screenshot:file:/tmp/old-listing.png',
        visualFreshness: 'previous',
        openSurfaces: expect.arrayContaining([
          expect.objectContaining({ selector: '#detail' }),
        ]),
        actionCandidates: expect.arrayContaining([
          expect.objectContaining({ type: 'pagination_action', text: '2' }),
        ]),
      }),
      agentMemory: expect.objectContaining({
        currentBrowserState: expect.objectContaining({
          visualFreshness: 'previous',
        }),
      }),
    });
  });

  it('exposes optional browser document-action verifier when the provider supports it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = createGantryBrowserGatewayAgentTools({
      status: () => ({ status: 'open' }),
      open: () => ({ status: 'open' }),
      inspect: () => ({ status: 'completed' }),
      act: () => ({ status: 'completed' }),
      verifyDocumentAction: (request) => {
        calls.push(request);
        return {
          status: 'completed',
          documentActionProof: {
            status: 'download_observed',
            verified: true,
          },
        };
      },
      close: () => ({ status: 'closed' }),
    });
    const tool = tools.find(
      (entry) => entry.name === 'browser_verify_document_action',
    );

    await expect(
      tool?.execute(
        {
          selector: 'button.download-nit',
          reason: 'Verify row document download',
        },
        {
          taskType: 'test',
          correlationId: 'verify-doc',
          step: 7,
          state: {},
        },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      documentActionProof: {
        status: 'download_observed',
      },
    });
    expect(calls[0]).toMatchObject({
      toolName: 'browser_verify_document_action',
      selector: 'button.download-nit',
      reason: 'Verify row document download',
    });
  });

  it('keeps failed action fingerprints in agent memory across the next step', async () => {
    const modelStates: Array<Record<string, unknown>> = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          modelStates.push(input.input as Record<string, unknown>);
          if (modelStates.length === 1) {
            return {
              action: 'call_tool',
              toolName: 'click_button',
              input: { target: { fingerprint: 'click:latest-tenders' } },
              previousGoalEvaluation: {
                goal: null,
                status: 'not_evaluated',
                evidenceRefs: [],
                reason: 'First action.',
              },
              memoryUpdate: {},
              nextGoal: {
                goal: 'open listing',
                requiredEvidence: ['state change'],
                recommendedTool: 'click_button',
              },
            };
          }
          return {
            action: 'final',
            output: { status: 'needs_review', reason: 'no progress click' },
            previousGoalEvaluation: {
              goal: 'open listing',
              status: 'failed',
              evidenceRefs: [],
              reason: 'The click made no progress.',
            },
            memoryUpdate: {},
            nextGoal: {
              goal: 'recover with a different route',
              requiredEvidence: ['new browser inspection'],
              recommendedTool: 'browser_inspect',
            },
          };
        },
      },
    });

    await runner.runAgentTask?.({
      taskType: 'generic.failed-action-memory',
      instructions: 'Do not repeat no-progress clicks.',
      input: {},
      tools: [
        {
          name: 'click_button',
          execute: () => ({
            status: 'completed',
            pageTransition: {
              outcome: 'no_progress',
              reason: 'same page fingerprint',
              selectedAction: { fingerprint: 'click:latest-tenders' },
            },
          }),
        },
      ],
      maxSteps: 2,
    });

    const secondState = modelStates[1]?.state as Record<string, unknown>;
    expect(secondState).toMatchObject({
      agentMemory: expect.objectContaining({
        failedActions: expect.arrayContaining([
          expect.objectContaining({
            fingerprint: 'click:latest-tenders',
            retryPolicy: 'do_not_repeat',
          }),
        ]),
      }),
    });
  });

  it('continues with recovery context after one empty model action', async () => {
    const modelStates: Array<Record<string, unknown>> = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          modelStates.push(input.input as Record<string, unknown>);
          if (modelStates.length === 1) {
            return {
              action: '',
              previousGoalEvaluation: {
                goal: 'solve captcha',
                status: 'partial',
                evidenceRefs: [],
                reason: 'The captcha input was filled.',
              },
              memoryUpdate: {},
              nextGoal: {
                goal: 'inspect after fill',
                requiredEvidence: ['current browser state'],
                recommendedTool: 'browser_inspect',
              },
            };
          }
          expect((input.input as Record<string, unknown>).state).toMatchObject({
            recoveryHint: expect.objectContaining({
              error: 'unsupported_agent_action',
              unsupportedAction: 'empty_action',
            }),
          });
          return {
            action: 'final',
            output: {
              status: 'needs_review',
              reason: 'recovered from empty action',
            },
            previousGoalEvaluation: {
              goal: 'inspect after fill',
              status: 'not_evaluated',
              evidenceRefs: [],
              reason: 'Recovered from invalid action.',
            },
            memoryUpdate: {},
            nextGoal: {
              goal: 'continue',
              requiredEvidence: [],
              recommendedTool: null,
            },
          };
        },
      },
    });

    const result = await runner.runAgentTask?.({
      taskType: 'generic.empty-action-recovery',
      instructions: 'Recover from invalid model actions.',
      input: {},
      tools: [],
      maxSteps: 2,
    });

    expect(result).toMatchObject({
      status: 'needs_review',
      output: {
        reason: 'recovered from empty action',
      },
    });
    expect(result?.steps[0]).toMatchObject({
      actionType: 'empty_action',
      status: 'failed',
    });
  });

  it('filters available and callable agent tools per step', async () => {
    const modelInputs: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async (input) => {
          modelInputs.push(input.input);
          if (modelInputs.length === 1) {
            return {
              action: 'call_tool',
              toolName: 'search',
              input: { query: 'first' },
            };
          }
          return {
            action: 'call_tool',
            toolName: 'search',
            input: { query: 'should be hidden' },
          };
        },
      },
    });

    await expect(
      runner.runAgentTask?.({
        taskType: 'generic.filtered_tools',
        instructions: 'Use tools until done.',
        input: {},
        maxSteps: 3,
        tools: [
          {
            name: 'search',
            execute: () => ({ status: 'found' }),
          },
          {
            name: 'finalize',
            execute: () => ({ finalOutput: { status: 'completed' } }),
          },
        ],
        selectStepTools: ({ step }) => (step >= 2 ? ['finalize'] : null),
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      output: {
        error: 'Unknown agent tool: search',
      },
    });

    expect(modelInputs[0]).toMatchObject({
      availableTools: [
        expect.objectContaining({ name: 'search' }),
        expect.objectContaining({ name: 'finalize' }),
      ],
    });
    expect(modelInputs[1]).toMatchObject({
      availableTools: [expect.objectContaining({ name: 'finalize' })],
    });
  });
});

function cryptoSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
