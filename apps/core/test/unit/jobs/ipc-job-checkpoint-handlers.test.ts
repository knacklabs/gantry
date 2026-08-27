import { beforeEach, describe, expect, it, vi } from 'vitest';

const acceptData = vi.hoisted(() => vi.fn());
const reject = vi.hoisted(() => vi.fn());
const activeLease = vi.hoisted(() => vi.fn());

vi.mock('@core/jobs/ipc-shared.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@core/jobs/ipc-shared.js')>();
  return {
    ...original,
    createTaskResponder: () => ({
      accept: vi.fn(),
      acceptData,
      reject,
    }),
  };
});
vi.mock(
  '@core/application/interactions/pending-interaction-durability.js',
  () => ({ isActiveRunLeaseForInteraction: activeLease }),
);

import { jobCheckpointTaskHandlers } from '@core/jobs/ipc-job-checkpoint-handlers.js';
import {
  observationEvidenceRefsMissingFromCheckpoint,
  websiteRecipeTestPlanShapeError,
} from '@core/jobs/ipc-job-checkpoint-handlers.js';
import { FileArtifactNotFoundError } from '@core/domain/file-artifacts/file-artifact.js';

describe('job checkpoint IPC handlers', () => {
  beforeEach(() => {
    acceptData.mockReset();
    reject.mockReset();
    activeLease.mockReset().mockResolvedValue(true);
  });

  it('loads the job-wide checkpoint only for the authenticated active run', async () => {
    const getLatestCheckpoint = vi.fn(async () => ({ sequence: 2 }));
    await jobCheckpointTaskHandlers.job_checkpoint_status?.({
      data: {
        type: 'job_checkpoint_status',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-2',
        sourceJobId: 'job-1',
        sourceRunId: 'run-2',
        runLeaseToken: 'lease-2',
        runLeaseFencingVersion: 2,
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          getLatestCheckpoint,
        }),
      },
    } as never);

    expect(getLatestCheckpoint).toHaveBeenCalledWith({
      appId: 'app-1',
      agentId: 'agent:recipe_agent',
      jobId: 'job-1',
    });
    expect(acceptData).toHaveBeenCalledWith(
      'Job checkpoint loaded.',
      expect.objectContaining({
        artifactScope: expect.stringMatching(/^job-/u),
        checkpoint: { sequence: 2 },
      }),
    );
  });

  it('rejects stale or cross-job checkpoint requests before repository access', async () => {
    const getLatestCheckpoint = vi.fn();
    await jobCheckpointTaskHandlers.job_checkpoint_status?.({
      data: {
        type: 'job_checkpoint_status',
        appId: 'app-1',
        jobId: 'job-forged',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          getLatestCheckpoint,
        }),
      },
    } as never);

    expect(reject).toHaveBeenCalledWith(
      'Job checkpoints require the authenticated scheduled job and run.',
      'forbidden',
    );
    expect(getLatestCheckpoint).not.toHaveBeenCalled();
  });

  it('marks a prior-run needs-review diagnosis for current-run revalidation', async () => {
    const checkpoint = {
      sequence: 2,
      milestone: 'needs_review',
      runId: 'run-1',
    };
    await jobCheckpointTaskHandlers.job_checkpoint_status?.({
      data: {
        type: 'job_checkpoint_status',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-2',
        sourceJobId: 'job-1',
        sourceRunId: 'run-2',
        runLeaseToken: 'lease-2',
        runLeaseFencingVersion: 2,
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          getLatestCheckpoint: vi.fn(async () => checkpoint),
        }),
      },
    } as never);

    expect(acceptData).toHaveBeenCalledWith(
      'Job checkpoint loaded.',
      expect.objectContaining({
        checkpoint,
        resumeDirective: expect.stringContaining('Revalidate its blocker'),
      }),
    );
  });

  it('requires fresh revalidation for a human wait from a prior run', async () => {
    const checkpoint = {
      sequence: 3,
      milestone: 'human_wait',
      runId: 'run-1',
      payload: { pendingInteractionRef: 'captcha-1' },
    };
    await jobCheckpointTaskHandlers.job_checkpoint_status?.({
      data: {
        type: 'job_checkpoint_status',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-2',
        sourceJobId: 'job-1',
        sourceRunId: 'run-2',
        runLeaseToken: 'lease-2',
        runLeaseFencingVersion: 2,
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          getLatestCheckpoint: vi.fn(async () => checkpoint),
        }),
      },
    } as never);

    expect(acceptData).toHaveBeenCalledWith(
      'Job checkpoint loaded.',
      expect.objectContaining({
        resumeDirective: expect.stringMatching(
          /historical.*cannot be resumed.*fresh automatic attempts.*new atomic human_wait/su,
        ),
      }),
    );
  });

  it('recognizes pendingInteractionRef as proof of an atomic human wait in the active run', async () => {
    const checkpoint = {
      sequence: 3,
      milestone: 'human_wait',
      runId: 'run-2',
      payload: { pendingInteractionRef: 'captcha-1' },
    };
    await jobCheckpointTaskHandlers.job_checkpoint_status?.({
      data: {
        type: 'job_checkpoint_status',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-2',
        sourceJobId: 'job-1',
        sourceRunId: 'run-2',
        runLeaseToken: 'lease-2',
        runLeaseFencingVersion: 2,
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          getLatestCheckpoint: vi.fn(async () => checkpoint),
        }),
      },
    } as never);

    expect(acceptData).toHaveBeenCalledWith(
      'Job checkpoint loaded.',
      expect.objectContaining({
        resumeDirective: expect.stringContaining('durable proof'),
      }),
    );
  });

  it('publishes a persisted semantic checkpoint through the existing task event stream', async () => {
    const publishRuntimeEvent = vi.fn();
    const checkpoint = {
      id: 'checkpoint-1',
      sequence: 1,
      payloadHash: 'sha256:checkpoint',
      milestone: 'inventory_completed',
      payload: {
        safePhase: 'inventory',
        artifactRefs: [],
        nextAction: 'Draft candidate',
        cumulativeRuntimeMs: 4_000,
      },
    };
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'inventory-1',
          expectedPreviousSequence: 0,
          milestone: 'inventory_completed',
          safePhase: 'inventory',
          artifactRefs: [],
          nextAction: 'Draft candidate',
          cumulativeRuntimeMs: 4_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          appendCheckpoint: vi.fn(async () => ({
            outcome: 'persisted',
            checkpoint,
          })),
        }),
        publishRuntimeEvent,
      },
    } as never);

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task.updated',
        jobId: 'job-1',
        payload: { type: 'job_checkpoint_saved', checkpoint },
      }),
    );
  });

  it('rejects model-authored evaluation_submitted checkpoints', async () => {
    const appendCheckpoint = vi.fn();
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'forged-submission',
          expectedPreviousSequence: 1,
          milestone: 'evaluation_submitted',
          safePhase: 'evaluation_ready',
          artifactRefs: [],
          nextAction: 'Analyze old result',
          cumulativeRuntimeMs: 5_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
      },
    } as never);

    expect(appendCheckpoint).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining('runtime-owned'),
      'invalid_checkpoint',
      [expect.stringContaining('test_plan_created')],
    );
  });

  it('rejects evaluation analysis without the latest runtime-owned invocation', async () => {
    const appendCheckpoint = vi.fn();
    const getLatestCheckpoint = vi.fn(async () => ({
      milestone: 'test_plan_created',
      payload: { evaluatorInvocationRef: null },
    }));
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'stale-analysis',
          expectedPreviousSequence: 1,
          milestone: 'evaluation_analyzed',
          safePhase: 'evaluation_analyzed_needs_review',
          artifactRefs: [],
          evaluatorInvocationRef: 'invocation:historical',
          nextAction: 'Finalize stale result',
          cumulativeRuntimeMs: 5_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          appendCheckpoint,
          getLatestCheckpoint,
        }),
      },
    } as never);

    expect(appendCheckpoint).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining('EVALUATION_PROOF_POLICY_STALE'),
      'invalid_checkpoint',
      expect.arrayContaining([expect.stringContaining('historical')]),
    );
  });

  it('rejects a checkpoint that omits evidence referenced by its inventory', async () => {
    const appendCheckpoint = vi.fn();
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'inventory-closure-1',
          expectedPreviousSequence: 0,
          milestone: 'inventory_completed',
          safePhase: 'inventory',
          artifactRefs: [
            {
              artifactId: 'file-artifact:inventory',
              contentHash: `sha256:${'a'.repeat(64)}`,
              kind: 'observation_inventory',
            },
          ],
          nextAction: 'Draft candidate',
          cumulativeRuntimeMs: 4_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getFileArtifactStore: () => ({
          readFileArtifact: vi.fn(async () => ({
            artifact: {},
            content: JSON.stringify({
              claims: [{ evidenceRefs: ['file-artifact:listing-proof'] }],
            }),
          })),
        }),
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
      },
    } as never);

    expect(appendCheckpoint).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining('file-artifact:listing-proof'),
      'invalid_checkpoint',
      [expect.stringContaining('Do not re-browse')],
    );
  });

  it('rejects a missing observation inventory without crashing the run', async () => {
    const appendCheckpoint = vi.fn();
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'missing-inventory-1',
          expectedPreviousSequence: 0,
          milestone: 'inventory_completed',
          safePhase: 'inventory',
          artifactRefs: [
            {
              artifactId: 'file-artifact:missing-inventory',
              contentHash: `sha256:${'a'.repeat(64)}`,
              kind: 'observation_inventory',
            },
          ],
          nextAction: 'Draft candidate',
          cumulativeRuntimeMs: 4_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getFileArtifactStore: () => ({
          readFileArtifact: vi.fn(async () => {
            throw new FileArtifactNotFoundError();
          }),
        }),
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
      },
    } as never);

    expect(appendCheckpoint).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining('file-artifact:missing-inventory'),
      'invalid_checkpoint',
      [expect.stringContaining('file action="write"')],
    );
  });

  it('computes inventory evidence closure without duplicate missing refs', () => {
    expect(
      observationEvidenceRefsMissingFromCheckpoint(
        JSON.stringify({
          claims: [
            { evidenceRefs: ['file-artifact:kept', 'file-artifact:missing'] },
            { evidenceRefs: ['file-artifact:missing'] },
          ],
        }),
        new Set(['file-artifact:kept']),
      ),
    ).toEqual(['file-artifact:missing']);
  });

  it('rejects array-shaped website recipe test plans before checkpointing', async () => {
    const appendCheckpoint = vi.fn();
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'invalid-test-plan-1',
          expectedPreviousSequence: 1,
          milestone: 'test_plan_created',
          safePhase: 'evaluation_ready',
          artifactRefs: [
            {
              artifactId: 'file-artifact:test-plan',
              contentHash: `sha256:${'a'.repeat(64)}`,
              kind: 'test_plan',
            },
          ],
          nextAction: 'Submit evaluation',
          cumulativeRuntimeMs: 5_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getFileArtifactStore: () => ({
          readFileArtifact: vi.fn(async () => ({
            artifact: {},
            content: JSON.stringify([
              { id: 'case-1', version: 'website_recipe.test_plan@1' },
            ]),
          })),
        }),
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
      },
    } as never);

    expect(appendCheckpoint).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining('top-level object'),
      'invalid_checkpoint',
      [expect.stringContaining('cases is the only array')],
    );
  });

  it('accepts only the versioned top-level website recipe test-plan shape', () => {
    expect(
      websiteRecipeTestPlanShapeError(
        JSON.stringify({
          version: 'website_recipe.test_plan@1',
          cases: [],
        }),
      ),
    ).toBeNull();
    expect(
      websiteRecipeTestPlanShapeError(JSON.stringify({ cases: [] })),
    ).toContain('top-level version');
  });

  it('rebases one atomic human-wait save after a sequence conflict', async () => {
    const checkpoint = {
      id: 'checkpoint-3',
      sequence: 3,
      payloadHash: 'sha256:checkpoint',
      milestone: 'human_wait',
      payload: {
        safePhase: 'human_wait',
        artifactRefs: [],
        nextAction: 'Await CAPTCHA answer',
        cumulativeRuntimeMs: 10_000,
      },
    };
    const appendCheckpoint = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'sequence_conflict',
        latestSequence: 2,
      })
      .mockResolvedValueOnce({ outcome: 'persisted', checkpoint });
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-2',
        sourceJobId: 'job-1',
        sourceRunId: 'run-2',
        runLeaseToken: 'lease-2',
        runLeaseFencingVersion: 2,
        payload: {
          idempotencyKey: 'captcha-wait-1',
          expectedPreviousSequence: 0,
          milestone: 'human_wait',
          safePhase: 'human_wait',
          artifactRefs: [],
          pendingInteractionRef: 'captcha-1',
          humanInteraction: { type: 'captcha' },
          nextAction: 'Await CAPTCHA answer',
          cumulativeRuntimeMs: 10_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
        publishRuntimeEvent: vi.fn(),
      },
    } as never);

    expect(appendCheckpoint).toHaveBeenCalledTimes(2);
    expect(appendCheckpoint.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ expectedPreviousSequence: 2 }),
    );
    expect(acceptData).toHaveBeenCalledWith(
      'Job checkpoint request completed.',
      { outcome: 'persisted', checkpoint },
    );
  });

  it('rejects a direct human-wait checkpoint without an atomic interaction reference', async () => {
    const appendCheckpoint = vi.fn();
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'captcha-wait-direct',
          expectedPreviousSequence: 0,
          milestone: 'human_wait',
          safePhase: 'human_wait',
          artifactRefs: [],
          nextAction: 'Await CAPTCHA answer',
          cumulativeRuntimeMs: 10_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
      },
    } as never);

    expect(appendCheckpoint).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      expect.stringContaining('atomic human-interaction tool'),
      'invalid_checkpoint',
      [expect.stringContaining('job_checkpoint_save')],
    );
  });

  it('returns authoritative artifact references when a checkpoint is invalid', async () => {
    const invalidCheckpoint = Object.assign(
      new Error('Artifact hash does not match.'),
      {
        name: 'InvalidJobSemanticCheckpointError',
      },
    );
    const artifactRefs = [
      {
        artifactId: 'file-artifact-1',
        contentHash: `sha256:${'a'.repeat(64)}`,
        kind: 'recipe_candidate',
      },
    ];
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save',
        appId: 'app-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          idempotencyKey: 'candidate-2',
          expectedPreviousSequence: 1,
          milestone: 'candidate_repaired',
          safePhase: 'candidate',
          artifactRefs,
          nextAction: 'Save repaired candidate',
          cumulativeRuntimeMs: 5_000,
        },
      },
      sourceAgentFolder: 'recipe_agent',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          appendCheckpoint: vi.fn(async () => {
            throw invalidCheckpoint;
          }),
          getLatestCheckpoint: vi.fn(async () => ({
            sequence: 1,
            payload: { artifactRefs },
          })),
        }),
      },
    } as never);

    expect(reject).toHaveBeenCalledWith(
      'Artifact hash does not match.',
      'invalid_checkpoint',
      [
        'latestSequence=1',
        `authoritativeArtifactRefs=${JSON.stringify(artifactRefs)}`,
      ],
    );
  });
});
