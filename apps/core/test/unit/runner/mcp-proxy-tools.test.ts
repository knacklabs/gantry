import { describe, expect, it } from 'vitest';

import {
  formatWebsiteRecipeEvaluatorRejection,
  modelVisibleExternalCapabilityResult,
} from '@core/runner/mcp/tools/external-capability-result.js';

describe('external capability model result', () => {
  it('exposes synchronous results as plain canonical JSON to the model', () => {
    const data = {
      // The compiler's domain status overwrites the synchronous transport
      // status before this result reaches the model projection.
      status: 'compiled',
      recipeSha256: 'sha256:recipe',
      coverageManifest: { requirements: [{ id: 'listing.dom' }] },
    };

    expect(modelVisibleExternalCapabilityResult('completed', data)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(data) }],
    });
  });

  it('keeps durable asynchronous acceptance message-only', () => {
    expect(
      modelVisibleExternalCapabilityResult('accepted and suspending', {
        status: 'accepted',
        taskId: 'task-1',
      }),
    ).toEqual({
      content: [{ type: 'text', text: 'accepted and suspending' }],
    });
  });
});

describe('website recipe evaluator rejection', () => {
  it('stops identical failed evaluation resubmission', () => {
    const text = formatWebsiteRecipeEvaluatorRejection(
      'UNCHANGED_FAILED_EVALUATION: the exact candidate already failed',
    );

    expect(text).toContain('Do not submit them again');
    expect(text).toContain('needs_review_proof_incomplete');
    expect(text).toContain('material repair');
  });

  it('keeps other pre-execution rejections repairable', () => {
    const text = formatWebsiteRecipeEvaluatorRejection('requestId is required');

    expect(text).toContain('Treat this as a repair observation');
    expect(text).not.toContain('needs_review_proof_incomplete');
  });
});
