import { describe, expect, it } from 'vitest';

import {
  buildGantryTaskLifecycleStreamEvent,
  normalizeDeepAgentStream,
  type LangGraphStreamEvent,
} from '@core/adapters/llm/deepagents-langchain/runner/stream-normalizer.js';
import type { RunnerOutputFrame } from '@core/runner/runner-frame.js';

async function* asStream(
  events: LangGraphStreamEvent[],
): AsyncIterable<LangGraphStreamEvent> {
  for (const event of events) yield event;
}

function streamEvent(text: string, usage?: { input: number; output: number }) {
  return {
    event: 'on_chat_model_stream',
    data: {
      chunk: {
        content: text,
        ...(usage
          ? {
              usage_metadata: {
                input_tokens: usage.input,
                output_tokens: usage.output,
              },
            }
          : {}),
      },
    },
  } satisfies LangGraphStreamEvent;
}

describe('normalizeDeepAgentStream', () => {
  it('emits ONLY token-delta frames and returns the terminal payload (no final frame here)', async () => {
    const frames: RunnerOutputFrame[] = [];
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('Hello '),
        streamEvent('world', { input: 120, output: 8 }),
      ]),
      newSessionId: 'session-1',
      modelId: 'gpt-5.5',
      modelProfile: { maxInputTokens: 400_000 },
      emit: (frame) => frames.push(frame),
    });

    expect(result.text).toBe('Hello world');
    // R2: the normalizer no longer emits a terminal frame; the caller owns the
    // single per-turn terminal marker. So only the two delta frames appear, and
    // none of them is a usage/terminal frame.
    expect(frames.map((frame) => frame.result)).toEqual(['Hello ', 'world']);
    expect(frames.every((f) => f.usage === undefined)).toBe(true);
    expect(frames.every((f) => f.newSessionId === 'session-1')).toBe(true);

    // The terminal payload is returned for the caller to emit. No cacheProvider
    // was passed (no prompt-cache lane), so cache accounting is unsupported.
    expect(result.terminalResult).toBeNull(); // partial text streamed
    expect(result.terminalUsage).toMatchObject({
      model: 'gpt-5.5',
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 120,
      cacheProvider: 'none',
      cacheStatus: 'unsupported',
    });
    expect(result.terminalContextUsage).toMatchObject({
      maxTokens: 400_000,
      totalTokens: 128,
      model: 'gpt-5.5',
      apiUsage: {
        input_tokens: 120,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    // A curated window yields a real (non-zero) usage percentage instead of the
    // empty-profile 0% — 128 / 400_000 * 100.
    expect(result.terminalContextUsage.percentage).toBeGreaterThan(0);
    expect(result.terminalContextUsage.percentage).toBeCloseTo(
      (128 / 400_000) * 100,
      6,
    );
  });

  it('prefers standardized contentBlocks and streams only visible text blocks', async () => {
    const frames: RunnerOutputFrame[] = [];
    const result = await normalizeDeepAgentStream({
      events: asStream([
        {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: 'fallback text must not stream',
              contentBlocks: [
                { type: 'reasoning', reasoning: 'The user is asking...' },
                { type: 'text', text: 'Visible ' },
                { type: 'thinking', thinking: 'No tools needed.' },
                'plain ',
                { type: 'redacted_thinking', data: 'hidden' },
                { type: 'text', text: 'answer' },
                { type: 'image', url: 'https://example.invalid/image.png' },
              ],
            },
          },
        },
      ]),
      newSessionId: 'session-blocks',
      modelProfile: { maxInputTokens: 1000 },
      emit: (frame) => frames.push(frame),
    });

    expect(result.text).toBe('Visible plain answer');
    expect(frames.map((frame) => frame.result)).toEqual([
      'Visible plain answer',
    ]);
    expect(JSON.stringify(frames)).not.toContain('The user is asking');
    expect(JSON.stringify(frames)).not.toContain('No tools needed');
    expect(JSON.stringify(frames)).not.toContain(
      'fallback text must not stream',
    );
  });

  it('prefers snake_case content_blocks and ignores provider reasoning blocks', async () => {
    const frames: RunnerOutputFrame[] = [];
    const result = await normalizeDeepAgentStream({
      events: asStream([
        {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: 'fallback text must not stream',
              content_blocks: [
                { type: 'text', text: 'Final ' },
                { type: 'reasoning', text: 'hidden reasoning' },
                { type: 'text', text: 'copy' },
              ],
            },
          },
        },
      ]),
      newSessionId: 'session-snake-blocks',
      modelProfile: { maxInputTokens: 1000 },
      emit: (frame) => frames.push(frame),
    });

    expect(result.text).toBe('Final copy');
    expect(frames.map((frame) => frame.result)).toEqual(['Final copy']);
    expect(JSON.stringify(frames)).not.toContain('hidden reasoning');
    expect(JSON.stringify(frames)).not.toContain(
      'fallback text must not stream',
    );
  });

  it('accounts OpenRouter-shaped cache reads/writes off the final raw usage', async () => {
    // ChatOpenRouter / the OpenRouter gateway surfaces the raw provider usage on
    // response_metadata.usage.prompt_tokens_details.{cached_tokens,
    // cache_write_tokens}. Reads are billed out of input.
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('hi'),
        {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: '',
              usage_metadata: {
                input_tokens: 1000,
                output_tokens: 20,
                input_token_details: { cache_read: 800 },
              },
              response_metadata: {
                usage: {
                  prompt_tokens: 1000,
                  completion_tokens: 20,
                  prompt_tokens_details: {
                    cached_tokens: 800,
                    cache_write_tokens: 150,
                  },
                },
              },
            },
          },
        },
      ]),
      newSessionId: 'session-or',
      modelId: 'moonshotai/kimi-k2.6',
      modelProfile: { maxInputTokens: 262_142 },
      cacheProvider: 'openrouter-provider',
      emit: () => {},
    });

    expect(result.terminalUsage).toMatchObject({
      model: 'moonshotai/kimi-k2.6',
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 150,
      // billable input = input - reads.
      totalBillableInputTokens: 200,
      cacheProvider: 'openrouter-provider',
      // reads + writes -> partial.
      cacheStatus: 'partial',
    });
    expect(result.terminalContextUsage.apiUsage).toMatchObject({
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 150,
    });
  });

  it('accounts OpenAI-shaped cache reads (cached_tokens only, no writes) as a hit', async () => {
    // ChatOpenAI emits a final empty chunk carrying response_metadata.usage with
    // prompt_tokens_details.cached_tokens (automatic caching, reads only).
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('answer'),
        {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: '',
              usage_metadata: {
                input_tokens: 500,
                output_tokens: 12,
                input_token_details: { cache_read: 320 },
              },
              response_metadata: {
                usage: {
                  prompt_tokens: 500,
                  completion_tokens: 12,
                  prompt_tokens_details: { cached_tokens: 320 },
                },
              },
            },
          },
        },
      ]),
      newSessionId: 'session-oai',
      modelId: 'gpt-5.5',
      modelProfile: { maxInputTokens: 400_000 },
      cacheProvider: 'openai',
      emit: () => {},
    });

    expect(result.terminalUsage).toMatchObject({
      inputTokens: 500,
      outputTokens: 12,
      cacheReadTokens: 320,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 180,
      cacheProvider: 'openai',
      // reads, no writes -> hit.
      cacheStatus: 'hit',
    });
  });

  it('accounts DeepSeek-shaped cache reads off the flat prompt_cache_hit_tokens field', async () => {
    // DeepSeek reports cache reads on a FLAT response_metadata.usage.
    // prompt_cache_hit_tokens field (not nested under prompt_tokens_details),
    // alongside prompt_cache_miss_tokens. No LangChain-normalized cache_read is
    // present, so the flat raw field must be read.
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('hi'),
        {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: '',
              usage_metadata: {
                input_tokens: 900,
                output_tokens: 15,
              },
              response_metadata: {
                usage: {
                  prompt_tokens: 900,
                  completion_tokens: 15,
                  prompt_cache_hit_tokens: 700,
                  prompt_cache_miss_tokens: 200,
                },
              },
            },
          },
        },
      ]),
      newSessionId: 'session-deepseek',
      modelId: 'deepseek-v4-pro',
      modelProfile: { maxInputTokens: 128_000 },
      cacheProvider: 'openai',
      emit: () => {},
    });

    expect(result.terminalUsage).toMatchObject({
      inputTokens: 900,
      outputTokens: 15,
      cacheReadTokens: 700,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 200,
      cacheProvider: 'openai',
      cacheStatus: 'hit',
    });
  });

  it('accounts Together-shaped cache reads off the flat cached_tokens field', async () => {
    // Together reports cache reads on a FLAT response_metadata.usage.cached_tokens
    // field (not nested under prompt_tokens_details).
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('hi'),
        {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: '',
              usage_metadata: {
                input_tokens: 400,
                output_tokens: 9,
              },
              response_metadata: {
                usage: {
                  prompt_tokens: 400,
                  completion_tokens: 9,
                  cached_tokens: 250,
                },
              },
            },
          },
        },
      ]),
      newSessionId: 'session-together',
      modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      modelProfile: { maxInputTokens: 128_000 },
      cacheProvider: 'openai',
      emit: () => {},
    });

    expect(result.terminalUsage).toMatchObject({
      inputTokens: 400,
      outputTokens: 9,
      cacheReadTokens: 250,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 150,
      cacheProvider: 'openai',
      cacheStatus: 'hit',
    });
  });

  it('falls back to LangChain input_token_details.cache_read when raw usage is absent', async () => {
    // ChatOpenRouter v0.3.0 maps cached_tokens -> usage_metadata.input_token_
    // details.cache_read but does NOT attach the raw response_metadata.usage on
    // streamed chunks, so reads must still be accounted from the normalized name.
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('hi'),
        {
          event: 'on_chat_model_stream',
          data: {
            chunk: {
              content: '',
              usage_metadata: {
                input_tokens: 600,
                output_tokens: 10,
                input_token_details: { cache_read: 600 },
              },
            },
          },
        },
      ]),
      newSessionId: 'session-or2',
      modelId: 'moonshotai/kimi-k2.6',
      modelProfile: { maxInputTokens: 262_142 },
      cacheProvider: 'openrouter-provider',
      emit: () => {},
    });

    expect(result.terminalUsage).toMatchObject({
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
      totalBillableInputTokens: 0,
      cacheProvider: 'openrouter-provider',
      cacheStatus: 'hit',
    });
  });

  it('reports zero max tokens when the model profile omits a context window', async () => {
    const result = await normalizeDeepAgentStream({
      events: asStream([streamEvent('hi', { input: 10, output: 2 })]),
      newSessionId: 'session-2',
      modelId: 'gpt-5.5',
      modelProfile: {},
      emit: () => {},
    });
    expect(result.terminalContextUsage.maxTokens).toBe(0);
    expect(result.terminalContextUsage.percentage).toBe(0);
  });

  it('keeps the cumulative (largest) usage across multiple chunks', async () => {
    const result = await normalizeDeepAgentStream({
      events: asStream([
        streamEvent('a', { input: 50, output: 1 }),
        streamEvent('b', { input: 50, output: 4 }),
      ]),
      newSessionId: 'session-3',
      modelProfile: { maxInputTokens: 1000 },
      emit: () => {},
    });
    expect(result.terminalUsage.inputTokens).toBe(50);
    expect(result.terminalUsage.outputTokens).toBe(4);
  });

  it('reports first stream event separately from first visible text', async () => {
    const firstEvents: string[] = [];
    let visibleTextCount = 0;

    await normalizeDeepAgentStream({
      events: asStream([
        {
          event: 'on_chat_model_start',
        },
        streamEvent('visible'),
      ]),
      newSessionId: 'session-timing',
      modelProfile: { maxInputTokens: 1000 },
      emit: () => {},
      onFirstEvent: (eventName) => firstEvents.push(eventName),
      onFirstVisibleText: () => {
        visibleTextCount += 1;
      },
    });

    expect(firstEvents).toEqual(['on_chat_model_start']);
    expect(visibleTextCount).toBe(1);
  });

  it('marks tool activity by name on each on_tool_start event', async () => {
    const toolStarts: string[] = [];
    await normalizeDeepAgentStream({
      events: asStream([
        { event: 'on_tool_start', name: 'RunCommand' },
        streamEvent('working'),
        { event: 'on_tool_start', name: 'send_message' },
      ]),
      newSessionId: 'session-tools',
      modelProfile: { maxInputTokens: 1000 },
      emit: () => {},
      onToolStart: (toolName) => toolStarts.push(toolName),
    });
    expect(toolStarts).toEqual(['RunCommand', 'send_message']);
  });

  it('emits sanitized task lifecycle runtime events from Gantry-owned observations', async () => {
    const frames: RunnerOutputFrame[] = [];
    await normalizeDeepAgentStream({
      events: asStream([
        buildGantryTaskLifecycleStreamEvent({
          kind: 'started',
          taskId: 'task-1',
          toolUseId: 'toolu-1',
          description: 'Research pricing',
          subagentType: 'general-purpose',
          taskType: 'local_agent',
          workflowName: 'pricing',
          prompt: 'raw delegated prompt must not leak',
        } as Parameters<typeof buildGantryTaskLifecycleStreamEvent>[0]),
        buildGantryTaskLifecycleStreamEvent({
          kind: 'progress',
          taskId: 'task-1',
          toolUseId: 'toolu-1',
          summary: 'two sources checked',
          lastToolName: 'WebSearch',
          usage: {
            totalTokens: 123,
            toolUses: 2,
            durationMs: 456,
            rawTokens: 999,
          },
        } as Parameters<typeof buildGantryTaskLifecycleStreamEvent>[0]),
        buildGantryTaskLifecycleStreamEvent({
          kind: 'updated',
          taskId: 'task-1',
          patch: {
            status: 'running',
            description: 'Research pricing',
            totalPausedMs: 0,
            isBackgrounded: true,
            hasError: true,
            error: 'raw task error must not leak',
          },
        } as Parameters<typeof buildGantryTaskLifecycleStreamEvent>[0]),
        buildGantryTaskLifecycleStreamEvent({
          kind: 'notification',
          taskId: 'task-1',
          status: 'completed',
          summary: 'subagent done',
          outputFile: '/tmp/raw-task-output.json',
        } as Parameters<typeof buildGantryTaskLifecycleStreamEvent>[0]),
      ]),
      newSessionId: 'session-task',
      modelProfile: { maxInputTokens: 1000 },
      runtimeEventContext: {
        appId: 'app-one',
        agentId: 'agent:team',
        runId: 'run-1',
        jobId: 'job-1',
        conversationId: 'tg:team',
        threadId: 'thread-1',
        actor: 'deepagents',
      },
      emit: (frame) => frames.push(frame),
    });

    expect(frames.map((frame) => frame.runtimeEventOnly)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const taskEvents = frames.flatMap((frame) => frame.runtimeEvents ?? []);
    expect(taskEvents).toEqual([
      expect.objectContaining({
        eventType: 'task.started',
        actor: 'deepagents',
        payload: {
          taskId: 'task-1',
          toolUseId: 'toolu-1',
          description: 'Research pricing',
          subagentType: 'general-purpose',
          taskKind: 'delegated_agent',
          workflowName: 'pricing',
          skipTranscript: false,
        },
      }),
      expect.objectContaining({
        eventType: 'task.progress',
        payload: {
          taskId: 'task-1',
          toolUseId: 'toolu-1',
          lastToolName: 'WebSearch',
          summary: 'two sources checked',
          usage: {
            totalTokens: 123,
            toolUses: 2,
            durationMs: 456,
          },
        },
      }),
      expect.objectContaining({
        eventType: 'task.updated',
        payload: {
          taskId: 'task-1',
          patch: {
            status: 'running',
            description: 'Research pricing',
            totalPausedMs: 0,
            isBackgrounded: true,
            hasError: true,
          },
        },
      }),
      expect.objectContaining({
        eventType: 'task.notification',
        payload: {
          taskId: 'task-1',
          status: 'completed',
          summary: 'subagent done',
          skipTranscript: false,
        },
      }),
    ]);
    expect(JSON.stringify(taskEvents)).not.toContain(
      'raw delegated prompt must not leak',
    );
    expect(JSON.stringify(taskEvents)).not.toContain(
      'raw task error must not leak',
    );
    expect(JSON.stringify(taskEvents)).not.toContain(
      '/tmp/raw-task-output.json',
    );
  });

  it('ignores custom lifecycle-shaped stream events without Gantry ownership', async () => {
    const frames: RunnerOutputFrame[] = [];
    await normalizeDeepAgentStream({
      events: asStream([
        {
          event: 'gantry_task_lifecycle',
          data: {
            output: {
              kind: 'progress',
              taskId: 'task-from-custom-event',
              summary: 'custom event must not become runtime evidence',
            },
          },
        },
      ]),
      newSessionId: 'session-task',
      modelProfile: { maxInputTokens: 1000 },
      runtimeEventContext: {
        appId: 'app-one',
        agentId: 'agent:team',
        runId: 'run-1',
        conversationId: 'tg:team',
        actor: 'deepagents',
      },
      emit: (frame) => frames.push(frame),
    });

    expect(frames).toEqual([]);
  });

  it('returns the assistant text as the terminal result when no partial text streamed', async () => {
    const frames: RunnerOutputFrame[] = [];
    const result = await normalizeDeepAgentStream({
      events: asStream([
        {
          event: 'on_chat_model_end',
          data: {
            output: { usage_metadata: { input_tokens: 5, output_tokens: 3 } },
          },
        },
      ]),
      newSessionId: 'session-4',
      modelProfile: { maxInputTokens: 1000 },
      emit: (frame) => frames.push(frame),
    });
    // No delta frames emitted (no streamed text).
    expect(frames).toHaveLength(0);
    expect(result.terminalResult).toBeNull();
    expect(result.terminalUsage.outputTokens).toBe(3);
  });
});
