import { describe, expect, it } from 'vitest';

import { QueryFailure } from '@core/adapters/llm/anthropic-claude-agent/runner/query-failure.exception.js';
import { handleResultMessage } from '@core/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-messages.js';
import type { QueryLoopContext } from '@core/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.js';

describe('claude query loop', () => {
  it('a failed result throws a QueryFailure carrying the accumulated usage', async () => {
    const context = {
      agentInput: { sessionId: 'session-1' },
      configuredModel: 'claude-sonnet-4-6',
      elapsedMs: () => 0,
      firstResultMs: undefined,
      newSessionId: 'session-1',
      queryRunId: 'query-1',
      resultCount: 0,
      sawAssistantContentSinceLastResult: false,
      sawPartialTextSinceLastResult: false,
      sawStructuredTextSinceLastResult: false,
    } as QueryLoopContext;

    const failure = handleResultMessage(context, {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['Provider unavailable.'],
      request_id: 'usage-event-1',
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 1_000,
          outputTokens: 12,
          cacheReadInputTokens: 270_000,
          cacheCreationInputTokens: 500,
        },
      },
    } as never);

    await expect(failure).rejects.toBeInstanceOf(QueryFailure);
    await expect(failure).rejects.toMatchObject({
      partialUsage: {
        usageEventId: 'usage-event-1',
        usage: {
          inputTokens: 1_000,
          outputTokens: 12,
          cacheReadTokens: 270_000,
          cacheWriteTokens: 500,
        },
      },
    });
  });
});
