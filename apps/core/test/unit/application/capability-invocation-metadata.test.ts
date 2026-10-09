import { describe, expect, it } from 'vitest';

import { capabilityInvocationMetadata } from '@core/application/mcp/capability-invocation-metadata.js';

const identity = {
  appId: 'manipal-tender-copilot',
  jobId: 'job-1',
  runId: 'run-1',
  capabilityId: 'manipal.website-recipe-flow@4',
  operation: 'test_recipe',
  idempotencyKey: 'test-recipe-1',
  arguments: {
    requestId: 'req-1',
    recipe: { Zeta: 1, alpha: [true, null, 'ä'], _x: { b: 2, B: 3, a: 1.5 } },
    observationInventory: {},
    expectedSamples: [{ fields: { title: 'प्रकाशित' } }],
  },
};

describe('capabilityInvocationMetadata', () => {
  it('binds the call to its job, run and operation with the provider canonical argument digest', () => {
    // Digest from @knacklabs/agent-tender canonicalJsonSha256 (code-unit key order) for the same arguments.
    expect(capabilityInvocationMetadata(identity)).toEqual({
      'gantry.invocation': {
        version: 'gantry.capability_invocation@1',
        appId: 'manipal-tender-copilot',
        jobId: 'job-1',
        runId: 'run-1',
        capabilityId: 'manipal.website-recipe-flow@4',
        operation: 'test_recipe',
        invocationId: 'invocation:test-recipe-1',
        argumentsSha256: 'sha256:31be943ee56ad1e5d6dfb7d6126b44d74c7cbddc581da5cdecd33892e25482d5',
      },
    });
  });

  it('keeps invocation ids within the provider limit', () => {
    const id = (capabilityInvocationMetadata({ ...identity, idempotencyKey: 'k'.repeat(400) })['gantry.invocation'] as {
      invocationId: string;
    }).invocationId;
    expect(id).toMatch(/^invocation:sha256:[0-9a-f]{64}$/);
  });
});
