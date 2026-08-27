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
import { toPublicAsyncTaskDto } from '../domain/ports/async-tasks.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import {
  FileArtifactNotFoundError,
  type FileArtifactId,
} from '../domain/file-artifacts/file-artifact.js';

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
      ...(checkpoint?.milestone === 'needs_review' && checkpoint.runId !== runId
        ? {
            resumeDirective:
              'This needs_review checkpoint is historical. Revalidate its blocker with current-run tools before returning terminal output; do not copy the prior diagnosis as current evidence.',
          }
        : checkpoint?.milestone === 'human_wait' && checkpoint.runId !== runId
          ? {
              resumeDirective:
                'This human_wait checkpoint is historical. Its prior interaction and browser session cannot be resumed; pendingInteractionRef is audit evidence only. Revalidate the blocker with the current browser. For CAPTCHA, complete the required fresh automatic attempts and, if still blocked, create a new atomic human_wait with job_checkpoint_save and humanInteraction. Never call website_recipe_request_human directly or request access for it.',
            }
          : checkpoint?.milestone === 'human_wait'
            ? {
                resumeDirective: checkpoint.payload.pendingInteractionRef
                  ? 'This human_wait checkpoint used the atomic contract. pendingInteractionRef is the durable proof; the original humanInteraction arguments are deliberately not stored. Never classify it as legacy because those raw arguments are absent.'
                  : 'This human_wait checkpoint predates the atomic contract because pendingInteractionRef is absent. Administrator clean rebuild is required.',
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
  if (payload.milestone === 'evaluation_submitted') {
    reject(
      'evaluation_submitted is runtime-owned and may only be recorded after the evaluator accepts the submission.',
      'invalid_checkpoint',
      [
        'Save milestone="test_plan_created" with safePhase="evaluation_ready" and retain recipe_candidate, observation_inventory, test_plan, and evaluation_submit_args. Then call the external evaluator capability. Gantry records evaluation_submitted automatically.',
      ],
    );
    return;
  }
  if (payload.milestone === 'evaluation_analyzed') {
    const latest = await repository.getLatestCheckpoint({
      appId: data.appId,
      agentId,
      jobId,
    });
    const submittedInvocationRef =
      latest?.payload.evaluatorInvocationRef ?? null;
    if (
      latest?.milestone !== 'evaluation_submitted' ||
      !submittedInvocationRef ||
      payload.evaluatorInvocationRef !== submittedInvocationRef
    ) {
      reject(
        'EVALUATION_PROOF_POLICY_STALE: evaluation_analyzed requires the evaluator invocation accepted after the latest evaluation_ready checkpoint.',
        'invalid_checkpoint',
        [
          'Do not analyze or finalize from a historical evaluator result.',
          'Save milestone="test_plan_created" with safePhase="evaluation_ready" and the complete evaluation_submit_args artifact, call the external evaluator capability, and analyze only the invocationRef in Gantry\'s runtime-owned evaluation_submitted checkpoint.',
        ],
      );
      return;
    }
  }
  if (
    payload.milestone === 'human_wait' &&
    (!payload.humanInteraction || !payload.pendingInteractionRef)
  ) {
    reject(
      'human_wait must be created through the atomic human-interaction tool; direct checkpoints without pendingInteractionRef are not resumable.',
      'invalid_checkpoint',
      [
        'Call job_checkpoint_save with milestone="human_wait" and humanInteraction so it creates the checkpoint and typed request atomically.',
      ],
    );
    return;
  }
  const artifactRefs = Array.isArray(payload.artifactRefs)
    ? payload.artifactRefs
    : [];
  const inventoryRefs = artifactRefs.filter(
    (ref): ref is { artifactId: string; contentHash: string; kind: string } =>
      Boolean(
        ref &&
        typeof ref === 'object' &&
        (ref as { kind?: unknown }).kind === 'observation_inventory' &&
        typeof (ref as { artifactId?: unknown }).artifactId === 'string',
      ),
  );
  const testPlanRefs = artifactRefs.filter(
    (ref): ref is { artifactId: string; contentHash: string; kind: string } =>
      Boolean(
        ref &&
        typeof ref === 'object' &&
        (ref as { kind?: unknown }).kind === 'test_plan' &&
        typeof (ref as { artifactId?: unknown }).artifactId === 'string',
      ),
  );
  const artifactStore = deps.getFileArtifactStore?.();
  if (artifactStore && inventoryRefs.length > 0) {
    const retainedIds = new Set(
      artifactRefs
        .map((ref) =>
          ref && typeof ref === 'object'
            ? (ref as { artifactId?: unknown }).artifactId
            : undefined,
        )
        .filter((id): id is string => typeof id === 'string'),
    );
    const missingEvidenceIds = new Set<string>();
    for (const inventoryRef of inventoryRefs) {
      let inventory: Awaited<ReturnType<typeof artifactStore.readFileArtifact>>;
      try {
        inventory = await artifactStore.readFileArtifact({
          id: inventoryRef.artifactId as FileArtifactId,
          appId: data.appId,
          agentId,
        });
      } catch (error) {
        if (!(error instanceof FileArtifactNotFoundError)) throw error;
        reject(
          `Observation inventory artifact does not exist: ${inventoryRef.artifactId}`,
          'invalid_checkpoint',
          [
            'Write the observation inventory with file action="write", then use the exact artifact id and content hash returned by that successful write. Never invent or reuse an uncommitted FileArtifact id.',
          ],
        );
        return;
      }
      for (const missingId of observationEvidenceRefsMissingFromCheckpoint(
        inventory.content,
        retainedIds,
      )) {
        missingEvidenceIds.add(missingId);
      }
    }
    if (missingEvidenceIds.size > 0) {
      const missing = [...missingEvidenceIds].sort();
      reject(
        `Observation inventory evidence is not closed over the checkpoint: ${missing.join(', ')}`,
        'invalid_checkpoint',
        [
          'Retain every FileArtifact named by observationInventory.claims[].evidenceRefs in artifactRefs, then save the same milestone again. Do not re-browse or recreate existing evidence.',
        ],
      );
      return;
    }
  }
  if (
    artifactStore &&
    payload.milestone === 'test_plan_created' &&
    testPlanRefs.length > 0
  ) {
    for (const testPlanRef of testPlanRefs) {
      let testPlan: Awaited<ReturnType<typeof artifactStore.readFileArtifact>>;
      try {
        testPlan = await artifactStore.readFileArtifact({
          id: testPlanRef.artifactId as FileArtifactId,
          appId: data.appId,
          agentId,
        });
      } catch (error) {
        if (!(error instanceof FileArtifactNotFoundError)) throw error;
        reject(
          `Website recipe test-plan artifact does not exist: ${testPlanRef.artifactId}`,
          'invalid_checkpoint',
          [
            'Write the test plan as one immutable FileArtifact before saving evaluation_ready.',
          ],
        );
        return;
      }
      const shapeError = websiteRecipeTestPlanShapeError(testPlan.content);
      if (shapeError) {
        reject(shapeError, 'invalid_checkpoint', [
          'Store one object shaped {version:"website_recipe.test_plan@1",recipeSha256,observationInventorySha256,coverageManifestSha256,cases}. cases is the only array; never store a bare cases array or put version on a case.',
        ]);
        return;
      }
    }
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
    payload: {
      safePhase: payload.safePhase,
      artifactRefs: payload.artifactRefs,
      evaluatorInvocationRef: payload.evaluatorInvocationRef,
      pendingInteractionRef: payload.pendingInteractionRef,
      nextAction: payload.nextAction,
      cumulativeRuntimeMs: payload.cumulativeRuntimeMs,
    } as JobSemanticCheckpointPayload,
  };
  let result: Awaited<ReturnType<typeof repository.appendCheckpoint>>;
  try {
    result = await repository.appendCheckpoint(checkpointInput);
    // A human-wait tool call also owns the live browser session. Rebase its
    // single atomic save once so an obsolete model sequence cannot discard a
    // fresh CAPTCHA/origin interaction before the model gets another turn.
    if (
      result.outcome === 'sequence_conflict' &&
      payload.milestone === 'human_wait'
    ) {
      result = await repository.appendCheckpoint({
        ...checkpointInput,
        expectedPreviousSequence: result.latestSequence,
      });
    }
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

export function observationEvidenceRefsMissingFromCheckpoint(
  content: Uint8Array | string,
  retainedArtifactIds: ReadonlySet<string>,
): string[] {
  const text =
    typeof content === 'string' ? content : new TextDecoder().decode(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const claims = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return [];
  const missing = new Set<string>();
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') continue;
    const evidenceRefs = (claim as { evidenceRefs?: unknown }).evidenceRefs;
    if (!Array.isArray(evidenceRefs)) continue;
    for (const evidenceRef of evidenceRefs) {
      if (
        typeof evidenceRef === 'string' &&
        evidenceRef.startsWith('file-artifact:') &&
        !retainedArtifactIds.has(evidenceRef)
      ) {
        missing.add(evidenceRef);
      }
    }
  }
  return [...missing].sort();
}

export function websiteRecipeTestPlanShapeError(
  content: Uint8Array | string,
): string | null {
  const text =
    typeof content === 'string' ? content : new TextDecoder().decode(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'Website recipe test-plan artifact must contain valid JSON.';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Website recipe test-plan artifact must be one top-level object; a bare cases array is invalid.';
  }
  const plan = parsed as { version?: unknown; cases?: unknown };
  if (plan.version !== 'website_recipe.test_plan@1') {
    return 'Website recipe test-plan artifact requires top-level version="website_recipe.test_plan@1".';
  }
  if (!Array.isArray(plan.cases)) {
    return 'Website recipe test-plan artifact requires a top-level cases array.';
  }
  return null;
}
