import { describe, expect, it } from 'vitest';

import { isAgentTurnCompleteMarker } from '@core/runtime/agent-output-callbacks.js';
import { providerSessionExternalSessionId } from '@core/runtime/agent-output-provider-session.js';
import type { AgentOutput } from '@core/runtime/agent-spawn-types.js';

describe('agent output callbacks', () => {
  it('treats final empty success events as turn completion markers even with usage', () => {
    const usageOnly = {
      status: 'success',
      result: null,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        totalBillableInputTokens: 60,
        cacheProvider: 'anthropic',
        cacheStatus: 'hit',
        at: new Date().toISOString(),
      },
    } satisfies AgentOutput;

    expect(isAgentTurnCompleteMarker(usageOnly)).toBe(true);
    expect(isAgentTurnCompleteMarker({ status: 'success', result: null })).toBe(
      true,
    );
  });

  it('does NOT treat a standalone session-init frame as turn completion, but still persists the session id (R1)', () => {
    // The DeepAgents lane emits an up-front session-id frame before any content
    // so the host persists the provider session early (launchd-restart safety).
    // It must NOT be mistaken for turn completion (that would idle + dequeue the
    // next message at turn START), yet the session id must still persist.
    const sessionInitFrame = {
      status: 'success',
      result: null,
      newSessionId: 'sess-abc123',
      sessionInit: true,
    } satisfies AgentOutput;

    expect(isAgentTurnCompleteMarker(sessionInitFrame)).toBe(false);
    // The host extracts the session id from newSessionId regardless of the
    // sessionInit flag, so early persistence is preserved.
    expect(providerSessionExternalSessionId(sessionInitFrame)).toBe(
      'sess-abc123',
    );
  });

  it('does NOT treat runtime-event-only frames as turn completion markers', () => {
    expect(
      isAgentTurnCompleteMarker({
        status: 'success',
        result: null,
        runtimeEventOnly: true,
        runtimeEvents: [
          {
            eventType: 'task.progress',
            payload: { taskId: 'task-1' },
          },
        ],
      }),
    ).toBe(false);
  });
});
