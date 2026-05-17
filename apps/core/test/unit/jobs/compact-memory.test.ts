import { describe, expect, it, vi } from 'vitest';

import {
  collectCompactBoundaryMemory,
  collectJobCompletionMemory,
} from '@core/jobs/compact-memory.js';

describe('collectCompactBoundaryMemory', () => {
  it('collects durable memory when a scheduled run reaches an SDK compact boundary', async () => {
    const collectMemory = vi.fn().mockResolvedValue({ saved: 2 });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await collectCompactBoundaryMemory({
      compactBoundary: true,
      agentSessionId: 'agent-session:job',
      collectMemory,
      logger,
      context: { jobId: 'job-1', runId: 'run-1' },
    });

    expect(collectMemory).toHaveBeenCalledWith({
      agentSessionId: 'agent-session:job',
      trigger: 'precompact',
    });
    expect(logger.info).toHaveBeenCalledWith(
      {
        jobId: 'job-1',
        runId: 'run-1',
        agentSessionId: 'agent-session:job',
        saved: 2,
      },
      'Collected durable memory at SDK compact boundary',
    );
  });

  it('forwards the runtime default scope for automatic compact memory', async () => {
    const collectMemory = vi.fn().mockResolvedValue({ saved: 1 });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await collectCompactBoundaryMemory({
      compactBoundary: true,
      agentSessionId: 'agent-session:dm',
      collectMemory,
      defaultScope: 'user',
      logger,
    });

    expect(collectMemory).toHaveBeenCalledWith({
      agentSessionId: 'agent-session:dm',
      trigger: 'precompact',
      defaultScope: 'user',
    });
  });

  it('does not collect without a compact boundary, canonical session, or collector', async () => {
    const collectMemory = vi.fn().mockResolvedValue({ saved: 1 });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await collectCompactBoundaryMemory({
      compactBoundary: false,
      agentSessionId: 'agent-session:job',
      collectMemory,
      logger,
    });
    await collectCompactBoundaryMemory({
      compactBoundary: true,
      collectMemory,
      logger,
    });
    await collectCompactBoundaryMemory({
      compactBoundary: true,
      agentSessionId: 'agent-session:job',
      logger,
    });

    expect(collectMemory).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and returns when compact-boundary memory collection times out', async () => {
    vi.useFakeTimers();
    try {
      const collectMemory = vi.fn(
        () => new Promise<{ saved: number }>(() => undefined),
      );
      const logger = { info: vi.fn(), warn: vi.fn() };

      const done = collectCompactBoundaryMemory({
        compactBoundary: true,
        agentSessionId: 'agent-session:job',
        collectMemory,
        logger,
        context: { jobId: 'job-1', runId: 'run-1' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        {
          jobId: 'job-1',
          runId: 'run-1',
          err: expect.any(Error),
        },
        'Failed to collect durable memory at SDK compact boundary',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collectJobCompletionMemory', () => {
  it('collects durable memory with job prompt and result after a successful job run', async () => {
    const collectMemory = vi.fn().mockResolvedValue({ saved: 1 });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await collectJobCompletionMemory({
      agentSessionId: 'agent-session:job',
      collectMemory,
      prompt: 'Remember that deployment approvals require owner review.',
      result: 'Confirmed the deployment approval process.',
      logger,
      context: { jobId: 'job-1', runId: 'run-1' },
    });

    expect(collectMemory).toHaveBeenCalledWith({
      agentSessionId: 'agent-session:job',
      trigger: 'session-end',
      additionalTurns: [
        {
          role: 'user',
          text: 'Remember that deployment approvals require owner review.',
        },
        {
          role: 'assistant',
          text: 'Confirmed the deployment approval process.',
        },
      ],
    });
    expect(logger.info).toHaveBeenCalledWith(
      {
        jobId: 'job-1',
        runId: 'run-1',
        agentSessionId: 'agent-session:job',
        saved: 1,
      },
      'Collected durable memory after successful job run',
    );
  });

  it('forwards the runtime default scope for automatic job completion memory', async () => {
    const collectMemory = vi.fn().mockResolvedValue({ saved: 1 });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await collectJobCompletionMemory({
      agentSessionId: 'agent-session:channel',
      collectMemory,
      defaultScope: 'group',
      prompt: 'Remember the channel release rule.',
      logger,
    });

    expect(collectMemory).toHaveBeenCalledWith({
      agentSessionId: 'agent-session:channel',
      trigger: 'session-end',
      defaultScope: 'group',
      additionalTurns: [
        { role: 'user', text: 'Remember the channel release rule.' },
      ],
    });
  });

  it('does not collect job completion memory without a session, collector, or turns', async () => {
    const collectMemory = vi.fn().mockResolvedValue({ saved: 1 });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await collectJobCompletionMemory({
      collectMemory,
      prompt: 'remember this',
      logger,
    });
    await collectJobCompletionMemory({
      agentSessionId: 'agent-session:job',
      prompt: 'remember this',
      logger,
    });
    await collectJobCompletionMemory({
      agentSessionId: 'agent-session:job',
      collectMemory,
      prompt: '   ',
      result: '',
      logger,
    });

    expect(collectMemory).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and returns when job completion memory collection times out', async () => {
    vi.useFakeTimers();
    try {
      const collectMemory = vi.fn(
        () => new Promise<{ saved: number }>(() => undefined),
      );
      const logger = { info: vi.fn(), warn: vi.fn() };

      const done = collectJobCompletionMemory({
        agentSessionId: 'agent-session:job',
        collectMemory,
        prompt: 'remember this',
        logger,
        context: { jobId: 'job-1', runId: 'run-1' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        {
          jobId: 'job-1',
          runId: 'run-1',
          err: expect.any(Error),
        },
        'Failed to collect durable memory after successful job run',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
