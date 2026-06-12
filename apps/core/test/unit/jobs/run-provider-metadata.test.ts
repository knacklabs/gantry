import { describe, expect, it, vi } from 'vitest';

import { createRunProviderMetadataUpdater } from '@core/jobs/run-provider-metadata.js';

function makeUpdater(
  overrides: {
    updateAgentRunProviderMetadata?: ReturnType<typeof vi.fn>;
    sessionRunId?: string;
    nowMs?: () => number;
  } = {},
) {
  const logger = { warn: vi.fn() };
  const updater = createRunProviderMetadataUpdater({
    opsRepository: {
      updateAgentRunProviderMetadata: overrides.updateAgentRunProviderMetadata,
    } as never,
    jobId: 'job-1',
    outerRunId: 'run-outer',
    leaseToken: 'lease-token-1',
    workerInstanceId: 'worker-1',
    fencingVersion: 7,
    getSessionRunId: () => overrides.sessionRunId,
    nowMs: overrides.nowMs ?? (() => 1_000),
    logger,
  });
  return { updater, logger };
}

describe('run provider metadata updater', () => {
  it('keeps non-forced provider metadata failures pending for a later flush', async () => {
    const updateAgentRunProviderMetadata = vi
      .fn()
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const { updater, logger } = makeUpdater({
      updateAgentRunProviderMetadata,
      sessionRunId: 'run-session',
    });

    await updater({ providerRunId: 'provider-run:1' });
    await updater({ force: true });

    expect(updateAgentRunProviderMetadata).toHaveBeenNthCalledWith(1, {
      runId: 'run-outer',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 7,
      providerRunId: 'provider-run:1',
    });
    expect(updateAgentRunProviderMetadata).toHaveBeenNthCalledWith(2, {
      runId: 'run-outer',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 7,
      providerRunId: 'provider-run:1',
    });
    expect(updateAgentRunProviderMetadata).toHaveBeenNthCalledWith(3, {
      runId: 'run-outer',
      runIds: ['run-session'],
      fenceRunId: 'run-outer',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 7,
      providerRunId: 'provider-run:1',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('throws when a forced final provider metadata persistence fails', async () => {
    const error = new Error('db unavailable');
    const { updater, logger } = makeUpdater({
      updateAgentRunProviderMetadata: vi.fn().mockRejectedValue(error),
    });

    await expect(
      updater({ providerRunId: 'provider-run:1', force: true }),
    ).rejects.toThrow(error);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('throws when forced metadata persistence is unavailable', async () => {
    const { updater } = makeUpdater();

    await expect(
      updater({ providerRunId: 'provider-run:1', force: true }),
    ).rejects.toThrow(
      /repository does not implement provider metadata updates/,
    );
  });

  it('preserves repository method context while persisting metadata', async () => {
    const calls: unknown[] = [];
    const opsRepository = {
      calls,
      async updateAgentRunProviderMetadata(input: unknown) {
        this.calls.push(input);
        return true;
      },
    };
    const updater = createRunProviderMetadataUpdater({
      opsRepository: opsRepository as never,
      jobId: 'job-1',
      outerRunId: 'run-outer',
      leaseToken: 'lease-token-1',
      workerInstanceId: 'worker-1',
      fencingVersion: 7,
      getSessionRunId: () => undefined,
      nowMs: () => 1_000,
      logger: { warn: vi.fn() },
    });

    await updater({ providerRunId: 'provider-run:1' });

    expect(calls).toEqual([
      {
        runId: 'run-outer',
        leaseToken: 'lease-token-1',
        workerInstanceId: 'worker-1',
        fencingVersion: 7,
        providerRunId: 'provider-run:1',
      },
    ]);
  });
});
