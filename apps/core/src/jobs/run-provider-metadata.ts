import type { SchedulerDependencies } from './types.js';

type LoggerLike = {
  warn(input: unknown, message: string): void;
};

export function createRunProviderMetadataUpdater(input: {
  opsRepository: SchedulerDependencies['opsRepository'];
  jobId: string;
  outerRunId: string;
  leaseToken?: string;
  workerInstanceId?: string;
  fencingVersion?: number;
  getSessionRunId: () => string | undefined;
  nowMs: () => number;
  logger: LoggerLike;
}): (metadata: {
  providerRunId?: string | null;
  providerSessionId?: string | null;
  force?: boolean;
}) => Promise<void> {
  let persistedProviderRunId: string | null | undefined;
  let persistedProviderSessionId: string | null | undefined;
  let pendingProviderRunId: string | null | undefined;
  let pendingProviderSessionId: string | null | undefined;
  let lastProviderMetadataUpdateMs = 0;

  return async (metadata) => {
    const updateMetadata =
      input.opsRepository.updateAgentRunProviderMetadata?.bind(
        input.opsRepository,
      );
    if (
      metadata.providerRunId !== undefined &&
      metadata.providerRunId !== persistedProviderRunId
    ) {
      pendingProviderRunId = metadata.providerRunId;
    }
    if (
      metadata.providerSessionId !== undefined &&
      metadata.providerSessionId !== persistedProviderSessionId
    ) {
      pendingProviderSessionId = metadata.providerSessionId;
    }
    if (
      pendingProviderRunId === undefined &&
      pendingProviderSessionId === undefined
    ) {
      return;
    }
    if (!updateMetadata) {
      if (metadata.force) {
        throw new Error(
          'Cannot force-persist scheduler run provider metadata: repository does not implement provider metadata updates.',
        );
      }
      return;
    }
    const timestampMs = input.nowMs();
    if (
      !metadata.force &&
      lastProviderMetadataUpdateMs > 0 &&
      timestampMs - lastProviderMetadataUpdateMs < 1000
    ) {
      return;
    }
    const update = {
      ...(pendingProviderRunId !== undefined
        ? { providerRunId: pendingProviderRunId }
        : {}),
      ...(pendingProviderSessionId !== undefined
        ? { providerSessionId: pendingProviderSessionId }
        : {}),
    };
    const sessionRunId = input.getSessionRunId();
    const runIds =
      sessionRunId && sessionRunId !== input.outerRunId
        ? [input.outerRunId, sessionRunId]
        : [input.outerRunId];
    try {
      const updateInput = {
        runId: input.outerRunId,
        ...(input.leaseToken
          ? {
              leaseToken: input.leaseToken,
              workerInstanceId: input.workerInstanceId,
              fencingVersion: input.fencingVersion,
            }
          : {}),
        ...update,
      };
      const updated = await updateMetadata(updateInput);
      if (input.leaseToken && !updated) {
        throw new Error(
          'Scheduler run lease is no longer active during provider metadata persistence.',
        );
      }
      if (sessionRunId && sessionRunId !== input.outerRunId) {
        const sessionUpdated = await updateMetadata({
          ...updateInput,
          runIds: [sessionRunId],
          fenceRunId: input.leaseToken ? input.outerRunId : undefined,
        });
        if (input.leaseToken && !sessionUpdated) {
          throw new Error(
            'Scheduler run lease is no longer active during session run provider metadata persistence.',
          );
        }
      }
      if (pendingProviderRunId !== undefined) {
        persistedProviderRunId = pendingProviderRunId;
        pendingProviderRunId = undefined;
      }
      if (pendingProviderSessionId !== undefined) {
        persistedProviderSessionId = pendingProviderSessionId;
        pendingProviderSessionId = undefined;
      }
      lastProviderMetadataUpdateMs = timestampMs;
    } catch (err) {
      input.logger.warn(
        { err, jobId: input.jobId, runIds },
        'Failed to update scheduler run provider metadata',
      );
      if (metadata.force) {
        throw err;
      }
    }
  };
}
