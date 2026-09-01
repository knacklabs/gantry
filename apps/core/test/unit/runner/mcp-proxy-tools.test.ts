import { describe, expect, it } from 'vitest';

import { modelVisibleExternalCapabilityResult } from '@core/runner/mcp/tools/external-capability-result.js';

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
