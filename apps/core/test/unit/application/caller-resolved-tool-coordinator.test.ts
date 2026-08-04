import { describe, expect, it } from 'vitest';

import {
  requestCallerResolvedTool,
  settleCallerResolvedTool,
} from '@core/application/interactions/caller-resolved-tool-coordinator.js';

describe('caller-resolved tool coordinator', () => {
  it('settles the waiting tool exactly once', async () => {
    let emitted!: () => void;
    const required = new Promise<void>((resolve) => (emitted = resolve));
    const result = requestCallerResolvedTool({
      appId: 'app',
      runId: 'run-1',
      sourceAgentFolder: 'agent-folder',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      toolName: 'opaque_tool',
      toolInput: { query: 'value' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      emitRequired: async () => emitted(),
    });
    await required;

    const settlement = {
      appId: 'app',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      idempotencyKey: 'delivery-1',
      resolution: { status: 'resolved' as const, result: { answer: 42 } },
    };
    await expect(settleCallerResolvedTool(settlement)).resolves.toBe(
      'resolved',
    );
    await expect(result).resolves.toEqual({ answer: 42 });
    await expect(settleCallerResolvedTool(settlement)).resolves.toBe(
      'idempotent',
    );
  });
});
