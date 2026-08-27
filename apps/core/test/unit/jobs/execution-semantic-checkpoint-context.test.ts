import { describe, expect, it } from 'vitest';

import type { JobSemanticCheckpoint } from '../../../src/domain/ports/job-semantic-checkpoints.js';
import { appendSemanticCheckpointContext } from '../../../src/jobs/execution-semantic-checkpoint-context.js';
import type { SemanticCapabilityDefinition } from '../../../src/shared/semantic-capabilities.js';

const evaluatorCapability: SemanticCapabilityDefinition = {
  capabilityId: 'manipal.website-recipe-evaluator',
  version: '1',
  displayName: 'Website recipe evaluator',
  category: 'evaluation',
  risk: 'write',
  can: 'Evaluate a recipe.',
  cannot: 'Access unrelated interfaces.',
  credentialSource: 'none',
  implementationBindings: [],
};

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
        kind: 'recipe_candidate',
      },
    ],
    nextAction: 'Compile the candidate.',
    cumulativeRuntimeMs: 10,
  },
  payloadHash: 'sha256:checkpoint',
  createdAt: '2026-08-24T00:00:00.000Z',
};

describe('appendSemanticCheckpointContext', () => {
  it('forces recipe jobs to resume from the latest durable checkpoint', () => {
    const prompt = appendSemanticCheckpointContext({
      prompt: 'Create a recipe.',
      semanticCapabilities: [evaluatorCapability],
      checkpoint,
    });

    expect(prompt).toContain('DURABLE_RECIPE_RESUME_CONTEXT_V1');
    expect(prompt).toContain('Compile the candidate.');
    expect(prompt).toContain('file-artifact:candidate');
    expect(prompt).toContain('do not repeat completed browsing');
  });

  it('does not alter unrelated jobs', () => {
    expect(
      appendSemanticCheckpointContext({
        prompt: 'Analyze tenders.',
        semanticCapabilities: [],
        checkpoint,
      }),
    ).toBe('Analyze tenders.');
  });
});
