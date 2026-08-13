import { beforeEach, describe, expect, it, vi } from 'vitest';

const acceptData = vi.hoisted(() => vi.fn());
const reject = vi.hoisted(() => vi.fn());
const activeLease = vi.hoisted(() => vi.fn());

vi.mock('@core/jobs/ipc-shared.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@core/jobs/ipc-shared.js')>();
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

  it('publishes a persisted semantic checkpoint through the existing task event stream', async () => {
    const publishRuntimeEvent = vi.fn();
    const checkpoint = {
      id: 'checkpoint-1', sequence: 1, payloadHash: 'sha256:checkpoint',
      milestone: 'inventory_completed', payload: {
        safePhase: 'inventory', artifactRefs: [], nextAction: 'Draft candidate',
        cumulativeRuntimeMs: 4_000,
      },
    };
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        type: 'job_checkpoint_save', appId: 'app-1', jobId: 'job-1', runId: 'run-1',
        sourceJobId: 'job-1', sourceRunId: 'run-1', runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1, payload: {
          idempotencyKey: 'inventory-1', expectedPreviousSequence: 0,
          milestone: 'inventory_completed', safePhase: 'inventory', artifactRefs: [],
          nextAction: 'Draft candidate', cumulativeRuntimeMs: 4_000,
        },
      },
      sourceAgentFolder: 'recipe_agent', sourceAgentFolderJids: [], conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({
          appendCheckpoint: vi.fn(async () => ({ outcome: 'persisted', checkpoint })),
        }),
        publishRuntimeEvent,
      },
    } as never);

    expect(publishRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'task.updated', jobId: 'job-1',
      payload: { type: 'job_checkpoint_saved', checkpoint },
    }));
  });
});
