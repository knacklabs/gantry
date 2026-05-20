import type { SchedulerDependencies } from './types.js';

type LoggerLike = {
  warn(input: unknown, message: string): void;
};

export function createRunProviderMetadataUpdater(input: {
  opsRepository: SchedulerDependencies['opsRepository'];
  jobId: string;
  outerRunId: string;
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
    const updateMetadata = input.opsRepository.updateAgentRunProviderMetadata;
    if (!updateMetadata) return;
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
    const runIds = sessionRunId
      ? [input.outerRunId, sessionRunId]
      : [input.outerRunId];
    await updateMetadata({ runId: input.outerRunId, runIds, ...update })
      .then(() => {
        if (pendingProviderRunId !== undefined) {
          persistedProviderRunId = pendingProviderRunId;
          pendingProviderRunId = undefined;
        }
        if (pendingProviderSessionId !== undefined) {
          persistedProviderSessionId = pendingProviderSessionId;
          pendingProviderSessionId = undefined;
        }
        lastProviderMetadataUpdateMs = timestampMs;
      })
      .catch((err) => {
        input.logger.warn(
          { err, jobId: input.jobId, runIds },
          'Failed to update scheduler run provider metadata',
        );
      });
  };
}
