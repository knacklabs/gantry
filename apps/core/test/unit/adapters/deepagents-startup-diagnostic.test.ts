import { describe, expect, it } from 'vitest';

import {
  buildDeepAgentStartupDiagnosticEvent,
  createDeepAgentStartupTiming,
} from '@core/adapters/llm/deepagents-langchain/runner/startup-diagnostic.js';
import type { DeepAgentRunnerInput } from '@core/adapters/llm/deepagents-langchain/runner/types.js';

const baseInput: DeepAgentRunnerInput = {
  prompt: 'do not include this prompt',
  appId: 'app-one',
  agentId: 'agent-one',
  runId: 'run-one',
  jobId: 'job-one',
  workspaceFolder: 'main_agent',
  chatJid: 'tg:group-one',
  threadId: 'reply-one',
  memoryContextBlock: 'private memory text',
};

describe('DeepAgents startup diagnostics', () => {
  it('records phase timings and separates first graph event from first visible output', async () => {
    let now = 100;
    const timing = createDeepAgentStartupTiming({ nowMs: () => now });

    expect(
      timing.measure('modelBuildMs', () => {
        now += 5;
        return 'model';
      }),
    ).toBe('model');
    await timing.measureAsync('mcpConnectMs', async () => {
      now += 12;
      return undefined;
    });
    now += 3;
    timing.markFirstLangGraphEvent('on_chat_model_start');
    now += 7;
    timing.markFirstVisibleOutput();
    now += 2;
    timing.markToolStart();
    now += 1;
    timing.markToolStart();
    now += 11;
    timing.markFirstLangGraphEvent('ignored_second_event');
    timing.markFirstVisibleOutput();

    expect(timing.snapshot()).toEqual({
      totalMs: 41,
      phases: {
        modelBuildMs: 5,
        mcpConnectMs: 12,
      },
      firstLangGraphEventMs: 20,
      firstLangGraphEventName: 'on_chat_model_start',
      firstVisibleOutputMs: 27,
      firstToolStartMs: 29,
      toolStartCount: 2,
    });
  });

  it('builds a sanitized runner startup runtime event with counts only', () => {
    const event = buildDeepAgentStartupDiagnosticEvent({
      agentInput: baseInput,
      modelProvider: 'openai',
      modelId: 'gpt-test',
      endpointFamily: 'openai',
      timing: {
        totalMs: 42,
        phases: {
          modelBuildMs: 3,
          systemPromptMs: 1,
          permissionEnvMs: 1,
          mcpConnectMs: 5,
          graphCreateMs: 2,
          turnMessagesMs: 1,
          streamIteratorMs: 1,
          streamNormalizeMs: 28,
        },
        firstLangGraphEventMs: 14,
        firstLangGraphEventName: 'on_chat_model_start',
        firstVisibleOutputMs: 21,
        toolsReadyMs: 8,
        firstToolStartMs: 30,
        toolStartCount: 2,
      },
      selectedAllowedToolCount: 4,
      connectedToolCount: 3,
      systemPromptChars: 123,
      memoryContextChars: 19,
      turnMessageCount: 2,
      cacheMode: 'automatic',
      checkpointerConfigured: true,
      checkpointTiming: {
        loadCount: 1,
        loadMs: 9,
        maxLoadMs: 9,
        writeCount: 3,
        writeMs: 18,
        maxWriteMs: 8,
      },
      scheduledJob: false,
    });

    expect(event).toMatchObject({
      appId: 'app-one',
      agentId: 'agent-one',
      runId: 'run-one',
      jobId: 'job-one',
      conversationId: 'tg:group-one',
      threadId: 'reply-one',
      eventType: 'run.startup_diagnostic',
      actor: 'runtime',
      responseMode: 'none',
      payload: {
        provider: 'deepagents',
        diagnostic: 'runner_startup',
        modelProvider: 'openai',
        modelId: 'gpt-test',
        endpointFamily: 'openai',
        selectedAllowedToolCount: 4,
        connectedToolCount: 3,
        systemPromptChars: 123,
        memoryContextChars: 19,
        turnMessageCount: 2,
        cacheMode: 'automatic',
        checkpointerConfigured: true,
        checkpointLoadCount: 1,
        checkpointLoadMs: 9,
        checkpointMaxLoadMs: 9,
        checkpointWriteCount: 3,
        checkpointWriteMs: 18,
        checkpointMaxWriteMs: 8,
        scheduledJob: false,
        totalMs: 42,
        toolsReadyMs: 8,
        firstLangGraphEventMs: 14,
        firstLangGraphEventName: 'on_chat_model_start',
        firstVisibleOutputMs: 21,
        firstToolStartMs: 30,
        toolStartCount: 2,
      },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('do not include this prompt');
    expect(serialized).not.toContain('private memory text');
    expect(serialized).not.toContain('http://127.0.0.1');
    expect(serialized).not.toContain('gtw_');
  });
});
