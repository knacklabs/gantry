import { isActiveRunLeaseForInteraction } from '../application/interactions/pending-interaction-durability.js';
import { z } from 'zod';
import {
  jobArtifactScope,
  type JobSemanticCheckpointMilestone,
  type JobSemanticCheckpointPayload,
} from '../domain/ports/job-semantic-checkpoints.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { stableSha256Json } from '../shared/stable-hash.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';
import { toPublicAsyncTaskDto } from '../domain/ports/async-tasks.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';

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
    const asyncTasks = deps.getAsyncTaskRepository?.();
    const completedExternalTasks = asyncTasks
      ? (
          await asyncTasks.listTasks({
            appId: data.appId,
            agentId,
            kind: 'external_capability',
            statuses: ['completed'],
            limit: 100,
            order: 'newest_first',
          })
        )
          .filter((task) => task.parentJobId === jobId)
          .slice(0, 20)
          .map(toPublicAsyncTaskDto)
      : [];
    acceptData('Job checkpoint loaded.', {
      artifactScope: jobArtifactScope(jobId),
      checkpoint,
      ...(checkpoint && checkpoint.runId !== runId
        ? {
            resumeDirective:
              'This checkpoint is historical. Revalidate any live browser, interaction, or external-task state required by nextAction before continuing.',
          }
        : {}),
      completedExternalTasks,
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
  const checkpointPayload = {
    safePhase: payload.safePhase,
    artifactRefs: payload.artifactRefs,
    evaluatorInvocationRef: payload.evaluatorInvocationRef,
    pendingInteractionRef: payload.pendingInteractionRef,
    nextAction: payload.nextAction,
    cumulativeRuntimeMs: payload.cumulativeRuntimeMs,
  };
  const job = deps.opsRepository
    ? await deps.opsRepository.getJobById(jobId)
    : null;
  const contract = job?.agent_task?.checkpointContract;
  if (!contract) {
    reject('This job has no registered checkpoint contract.', 'forbidden');
    return;
  }
  if (contract.schemaDigest !== `sha256:${stableSha256Json(contract.schema)}`) {
    reject('The registered checkpoint schema digest has drifted.', 'forbidden');
    return;
  }
  const validation = z
    .fromJSONSchema(contract.schema)
    .safeParse(checkpointPayload);
  if (!validation.success) {
    reject(
      'Checkpoint payload does not match the registered schema.',
      'invalid_checkpoint',
      validation.error.issues.map(
        (issue) => `${issue.path.join('.') || '$'}: ${issue.message}`,
      ),
    );
    return;
  }
  const checkpointInput = {
    id: `job-checkpoint-${stableSha256Json({ jobId, idempotencyKey }).slice(0, 48)}`,
    appId: data.appId,
    agentId,
    jobId,
    runId,
    leaseToken: data.runLeaseToken ?? '',
    expectedPreviousSequence: Number(expectedPreviousSequence),
    milestone: payload.milestone as JobSemanticCheckpointMilestone,
    payload: checkpointPayload as JobSemanticCheckpointPayload,
  };
  let result: Awaited<ReturnType<typeof repository.appendCheckpoint>>;
  try {
    result = await repository.appendCheckpoint(checkpointInput);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== 'InvalidJobSemanticCheckpointError'
    ) {
      throw error;
    }
    const latest = await repository.getLatestCheckpoint({
      appId: data.appId,
      agentId,
      jobId,
    });
    reject(error.message, 'invalid_checkpoint', [
      `latestSequence=${latest?.sequence ?? 0}`,
      `authoritativeArtifactRefs=${JSON.stringify(latest?.payload.artifactRefs ?? [])}`,
    ]);
    return;
  }
  if (result.outcome === 'persisted' || result.outcome === 'replayed') {
    await deps.publishRuntimeEvent?.({
      appId: data.appId as never,
      agentId: agentId as never,
      runId: runId as never,
      jobId: jobId as never,
      eventType: RUNTIME_EVENT_TYPES.TASK_UPDATED,
      actor: 'gantry-runtime',
      payload: {
        type: 'job_checkpoint_saved',
        checkpoint: result.checkpoint,
      },
    });
  }
  acceptData('Job checkpoint request completed.', result);
};

export const jobCheckpointTaskHandlers: Record<string, TaskHandler> = {
  job_checkpoint_status: checkpointHandler,
  job_checkpoint_save: checkpointHandler,
};
