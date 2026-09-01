import { beforeEach, describe, expect, it, vi } from 'vitest';

const acceptData = vi.hoisted(() => vi.fn());
const reject = vi.hoisted(() => vi.fn());
const activeLease = vi.hoisted(() => vi.fn());

vi.mock('@core/jobs/ipc-shared.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@core/jobs/ipc-shared.js')>();
  return {
    ...original,
    createTaskResponder: () => ({ accept: vi.fn(), acceptData, reject }),
  };
});
vi.mock(
  '@core/application/interactions/pending-interaction-durability.js',
  () => ({ isActiveRunLeaseForInteraction: activeLease }),
);

import { jobCheckpointTaskHandlers } from '@core/jobs/ipc-job-checkpoint-handlers.js';
import { stableSha256Json } from '@core/shared/stable-hash.js';

const schema = {
  type: 'object',
  properties: {
    safePhase: { type: 'string', minLength: 1 },
    artifactRefs: { type: 'array' },
    evaluatorInvocationRef: { type: ['string', 'null'] },
    pendingInteractionRef: { type: ['string', 'null'] },
    nextAction: { type: 'string', minLength: 1 },
    cumulativeRuntimeMs: { type: 'integer', minimum: 0 },
  },
  required: [
    'safePhase',
    'artifactRefs',
    'evaluatorInvocationRef',
    'pendingInteractionRef',
    'nextAction',
    'cumulativeRuntimeMs',
  ],
  additionalProperties: false,
};

const baseData = {
  appId: 'app-1',
  jobId: 'job-1',
  runId: 'run-1',
  sourceJobId: 'job-1',
  sourceRunId: 'run-1',
  runLeaseToken: 'lease-1',
  runLeaseFencingVersion: 1,
};

function job() {
  return {
    id: 'job-1',
    agent_task: {
      checkpointContract: {
        schema,
        schemaDigest: `sha256:${stableSha256Json(schema)}`,
      },
    },
  };
}

function savePayload(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'boundary-1',
    expectedPreviousSequence: 0,
    milestone: 'phase_completed',
    safePhase: 'phase:completed',
    artifactRefs: [],
    evaluatorInvocationRef: null,
    pendingInteractionRef: null,
    nextAction: 'Continue with the next phase.',
    cumulativeRuntimeMs: 1_000,
    ...overrides,
  };
}

describe('job checkpoint IPC handlers', () => {
  beforeEach(() => {
    acceptData.mockReset();
    reject.mockReset();
    activeLease.mockReset().mockResolvedValue(true);
  });

  it('loads the latest job-scoped checkpoint for an active lease', async () => {
    const getLatestCheckpoint = vi.fn(async () => ({ sequence: 2 }));
    await jobCheckpointTaskHandlers.job_checkpoint_status?.({
      data: { ...baseData, type: 'job_checkpoint_status' },
      sourceAgentFolder: 'agent-folder',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        getJobSemanticCheckpointRepository: () => ({ getLatestCheckpoint }),
      },
    } as never);

    expect(getLatestCheckpoint).toHaveBeenCalledWith({
      appId: 'app-1',
      agentId: 'agent:agent-folder',
      jobId: 'job-1',
    });
    expect(acceptData).toHaveBeenCalledWith(
      'Job checkpoint loaded.',
      expect.objectContaining({ checkpoint: { sequence: 2 } }),
    );
  });

  it('validates and stores an opaque payload against the job-pinned schema', async () => {
    const checkpoint = { id: 'checkpoint-1', sequence: 1 };
    const appendCheckpoint = vi.fn(async () => ({
      outcome: 'persisted' as const,
      checkpoint,
    }));
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        ...baseData,
        type: 'job_checkpoint_save',
        payload: savePayload(),
      },
      sourceAgentFolder: 'agent-folder',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        opsRepository: { getJobById: vi.fn(async () => job()) },
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
        publishRuntimeEvent: vi.fn(),
      },
    } as never);

    expect(appendCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        milestone: 'phase_completed',
        expectedPreviousSequence: 0,
        payload: expect.objectContaining({ safePhase: 'phase:completed' }),
      }),
    );
    expect(acceptData).toHaveBeenCalledWith(
      'Job checkpoint request completed.',
      { outcome: 'persisted', checkpoint },
    );
  });

  it('returns every structural schema issue without invoking storage', async () => {
    const appendCheckpoint = vi.fn();
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        ...baseData,
        type: 'job_checkpoint_save',
        payload: savePayload({ safePhase: '', cumulativeRuntimeMs: -1 }),
      },
      sourceAgentFolder: 'agent-folder',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        opsRepository: { getJobById: vi.fn(async () => job()) },
        getJobSemanticCheckpointRepository: () => ({ appendCheckpoint }),
      },
    } as never);

    expect(appendCheckpoint).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      'Checkpoint payload does not match the registered schema.',
      'invalid_checkpoint',
      expect.arrayContaining([
        expect.stringContaining('safePhase'),
        expect.stringContaining('cumulativeRuntimeMs'),
      ]),
    );
  });

  it('fails closed when the registered schema digest drifts', async () => {
    await jobCheckpointTaskHandlers.job_checkpoint_save?.({
      data: {
        ...baseData,
        type: 'job_checkpoint_save',
        payload: savePayload(),
      },
      sourceAgentFolder: 'agent-folder',
      sourceAgentFolderJids: [],
      conversationBindings: {},
      deps: {
        opsRepository: {
          getJobById: vi.fn(async () => ({
            ...job(),
            agent_task: {
              checkpointContract: {
                schema,
                schemaDigest: `sha256:${'0'.repeat(64)}`,
              },
            },
          })),
        },
        getJobSemanticCheckpointRepository: () => ({
          appendCheckpoint: vi.fn(),
        }),
      },
    } as never);

    expect(reject).toHaveBeenCalledWith(
      'The registered checkpoint schema digest has drifted.',
      'forbidden',
    );
  });
});
