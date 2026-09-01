import { describe, expect, it } from 'vitest';

import type { JobSemanticCheckpoint } from '@core/domain/ports/job-semantic-checkpoints.js';
import { appendSemanticCheckpointContext } from '@core/jobs/execution-semantic-checkpoint-context.js';

const checkpoint: JobSemanticCheckpoint = {
  id: 'checkpoint-1',
  appId: 'app-1',
  agentId: 'agent-1',
  jobId: 'job-1',
  runId: 'run-1',
  sequence: 2,
  workerInstanceId: 'worker-1',
  fencingVersion: 1,
  milestone: 'inventory_completed',
  payload: {
    safePhase: 'inventory:complete',
    artifactRefs: [
      {
        artifactId: 'file-artifact:candidate',
        contentHash: 'sha256:candidate',
        kind: 'candidate',
      },
    ],
    nextAction: 'Validate the candidate.',
    cumulativeRuntimeMs: 10,
  },
  payloadHash: 'sha256:checkpoint',
  createdAt: '2026-08-24T00:00:00.000Z',
};

describe('appendSemanticCheckpointContext', () => {
  it('resumes any checkpointed job from opaque durable state', () => {
    const prompt = appendSemanticCheckpointContext({
      prompt: 'Complete the task.',
      checkpoint,
    });

    expect(prompt).toContain('DURABLE_JOB_RESUME_CONTEXT_V1');
    expect(prompt).toContain('Validate the candidate.');
    expect(prompt).toContain('file-artifact:candidate');
    expect(prompt).toContain('do not repeat completed work');
  });

  it('does not alter a job without a checkpoint', () => {
    expect(
      appendSemanticCheckpointContext({
        prompt: 'Complete the task.',
        checkpoint: null,
      }),
    ).toBe('Complete the task.');
  });

  it('puts completed external results ahead of the checkpoint next action', () => {
    const prompt = appendSemanticCheckpointContext({
      prompt: 'Complete the task.',
      checkpoint,
      completedExternalTasks: [
        {
          id: 'task-1',
          kind: 'external_capability',
          status: 'completed',
          summary: 'Evaluate candidate.',
          outputSummary: 'Evaluation found a repairable failure.',
          resultRef: 'result-1',
          result: {
            status: 'failed',
            explanations: ['Selector main was not found.'],
          },
          receiptLines: ['Evaluation completed.'],
          allowedActions: ['get', 'list'],
          createdAt: '2026-08-24T00:00:01.000Z',
          updatedAt: '2026-08-24T00:00:02.000Z',
          terminalAt: '2026-08-24T00:00:02.000Z',
        },
      ],
    });

    expect(prompt).toContain('task-1');
    expect(prompt).toContain('Selector main was not found.');
    expect(prompt).toContain('Inspect every completed external task result');
    expect(prompt).toContain('do not resubmit an unchanged invocation');
  });
});
