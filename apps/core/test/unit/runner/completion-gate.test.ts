import { beforeEach, describe, expect, it, vi } from 'vitest';

const { submitTaskLifecycleDataRequest } = vi.hoisted(() => ({
  submitTaskLifecycleDataRequest: vi.fn(),
}));

vi.mock('@core/runner/mcp/tools/task-lifecycle.js', () => ({
  submitTaskLifecycleDataRequest,
}));

import { CompletionGate } from '@core/runner/completion-gate.js';

describe('CompletionGate', () => {
  beforeEach(() => submitTaskLifecycleDataRequest.mockReset());

  it('forwards a bounded caller gate request and accepts completion', async () => {
    submitTaskLifecycleDataRequest.mockResolvedValue({
      ok: true,
      data: { decision: 'accept', progressToken: 'covered-all' },
    });
    const gate = new CompletionGate({
      toolName: 'validate_completion',
      maxNoProgressContinuations: 2,
      interactionTimeoutMs: 90_000,
    });

    await expect(gate.check()).resolves.toEqual({
      decision: 'accept',
      progressToken: 'covered-all',
    });
    expect(submitTaskLifecycleDataRequest).toHaveBeenCalledWith({
      type: 'caller_resolved_tool',
      payload: {
        toolName: 'validate_completion',
        toolInput: { completionAttempt: 1 },
      },
      responseTimeoutMs: 95_000,
    });
  });

  it('fails when continuation repeats without progress', async () => {
    submitTaskLifecycleDataRequest.mockResolvedValue({
      ok: true,
      data: {
        decision: 'continue',
        progressToken: 'covered-11',
        message: 'Run the next batch.',
      },
    });
    const gate = new CompletionGate({
      toolName: 'validate_completion',
      maxNoProgressContinuations: 2,
      interactionTimeoutMs: 90_000,
    });

    await expect(gate.check()).resolves.toMatchObject({ decision: 'continue' });
    await expect(gate.check()).resolves.toMatchObject({ decision: 'continue' });
    await expect(gate.check()).rejects.toThrow(
      'repeated continuations without progress',
    );
  });
});
