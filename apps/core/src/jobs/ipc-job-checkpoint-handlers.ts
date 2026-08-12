import { isActiveRunLeaseForInteraction } from '../application/interactions/pending-interaction-durability.js';
import {
  jobArtifactScope,
  type JobSemanticCheckpointMilestone,
  type JobSemanticCheckpointPayload,
} from '../domain/ports/job-semantic-checkpoints.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { stableSha256Json } from '../shared/stable-hash.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';

const checkpointHandler: TaskHandler = async (context) => {
  const { data, deps, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 120 });
  const runId = toTrimmedString(data.runId, { maxLen: 120 });
  if (
    !data.appId ||
    !jobId ||
    !runId ||
    jobId !== data.sourceJobId ||
    runId !== data.sourceRunId
  ) {
    reject(
      'Job checkpoints require the authenticated scheduled job and run.',
      'forbidden',
    );
    return;
  }
  if (
    !(await isActiveRunLeaseForInteraction({
      runId,
      runLeaseToken: data.runLeaseToken,
      runLeaseFencingVersion: data.runLeaseFencingVersion,
    }))
  ) {
    reject('The scheduled job lease is no longer active.', 'stale_run_lease');
    return;
  }
  const repository = deps.getJobSemanticCheckpointRepository?.();
  if (!repository) {
    reject('Durable job checkpoints are unavailable.', 'unavailable');
    return;
  }
  const agentId = memoryAgentIdForWorkspaceFolder(sourceAgentFolder);
  if (data.type === 'job_checkpoint_status') {
    const checkpoint = await repository.getLatestCheckpoint({
      appId: data.appId,
      agentId,
      jobId,
    });
    acceptData('Job checkpoint loaded.', {
      artifactScope: jobArtifactScope(jobId),
      checkpoint,
    });
    return;
  }
  const payload = data.payload ?? {};
  const idempotencyKey = toTrimmedString(payload.idempotencyKey, {
    maxLen: 512,
  });
  if (!idempotencyKey) {
    reject('idempotencyKey is required.', 'invalid_request');
    return;
  }
  const expectedPreviousSequence = payload.expectedPreviousSequence;
  if (
    !Number.isSafeInteger(expectedPreviousSequence) ||
    Number(expectedPreviousSequence) < 0
  ) {
    reject(
      'expectedPreviousSequence must be a non-negative safe integer.',
      'invalid_request',
    );
    return;
  }
  const result = await repository.appendCheckpoint({
    id: `job-checkpoint-${stableSha256Json({ jobId, idempotencyKey }).slice(0, 48)}`,
    appId: data.appId,
    agentId,
    jobId,
    runId,
    leaseToken: data.runLeaseToken ?? '',
    expectedPreviousSequence: Number(expectedPreviousSequence),
    milestone: payload.milestone as JobSemanticCheckpointMilestone,
    payload: {
      safePhase: payload.safePhase,
      artifactRefs: payload.artifactRefs,
      evaluatorInvocationRef: payload.evaluatorInvocationRef,
      pendingInteractionRef: payload.pendingInteractionRef,
      nextAction: payload.nextAction,
      cumulativeRuntimeMs: payload.cumulativeRuntimeMs,
    } as JobSemanticCheckpointPayload,
  });
  acceptData('Job checkpoint request completed.', result);
};

export const jobCheckpointTaskHandlers: Record<string, TaskHandler> = {
  job_checkpoint_status: checkpointHandler,
  job_checkpoint_save: checkpointHandler,
};
