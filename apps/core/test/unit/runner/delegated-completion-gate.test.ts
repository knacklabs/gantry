import { beforeEach, describe, expect, it, vi } from 'vitest';

const { submitTaskLifecycleDataRequest } = vi.hoisted(() => ({
  submitTaskLifecycleDataRequest: vi.fn(),
}));

vi.mock('@core/runner/mcp/tools/task-lifecycle.js', () => ({
  submitTaskLifecycleDataRequest,
}));

import { DelegatedCompletionGate } from '@core/runner/delegated-completion-gate.js';

describe('DelegatedCompletionGate', () => {
  beforeEach(() => {
    submitTaskLifecycleDataRequest.mockReset();
  });

  it('accepts completion and forwards the fixed gate request', async () => {
    submitTaskLifecycleDataRequest.mockResolvedValue({
      taskId: 'gate-1',
      ok: true,
      data: { decision: 'accept', progressToken: 'covered-all' },
    });
    const gate = new DelegatedCompletionGate({
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

  it('fails after two consecutive continuation decisions without progress', async () => {
    submitTaskLifecycleDataRequest.mockResolvedValue({
      taskId: 'gate-1',
      ok: true,
      data: {
        decision: 'continue',
        progressToken: 'covered-11',
        message: 'Run the next batch.',
      },
    });
    const gate = new DelegatedCompletionGate({
      toolName: 'validate_completion',
      maxNoProgressContinuations: 2,
      interactionTimeoutMs: 90_000,
    });

    await expect(gate.check()).resolves.toMatchObject({
      decision: 'continue',
    });
    await expect(gate.check()).resolves.toMatchObject({
      decision: 'continue',
    });
    await expect(gate.check()).rejects.toThrow(
      'stopped after 2 consecutive continuations without progress',
    );
  });

  it('resets the no-progress count when the caller progress token changes', async () => {
    for (const progressToken of ['covered-11', 'covered-11', 'covered-15']) {
      submitTaskLifecycleDataRequest.mockResolvedValueOnce({
        taskId: 'gate-1',
        ok: true,
        data: {
          decision: 'continue',
          progressToken,
          message: 'Run the next batch.',
        },
      });
    }
    const gate = new DelegatedCompletionGate({
      toolName: 'validate_completion',
      maxNoProgressContinuations: 2,
      interactionTimeoutMs: 90_000,
    });

    await expect(gate.check()).resolves.toMatchObject({
      progressToken: 'covered-11',
    });
    await expect(gate.check()).resolves.toMatchObject({
      progressToken: 'covered-11',
    });
    await expect(gate.check()).resolves.toMatchObject({
      progressToken: 'covered-15',
    });
  });
});
