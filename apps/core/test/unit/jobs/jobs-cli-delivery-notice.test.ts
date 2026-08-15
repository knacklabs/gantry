import { describe, expect, it } from 'vitest';

import { formatJobDetail } from '@core/cli/jobs.js';
import { schedulerJobSummary } from '@core/runner/mcp/tools/scheduler-formatters.js';

describe('jobs CLI delivery notice', () => {
  it('renders setup.deliveryNotice in jobs show output', () => {
    const output = formatJobDetail({
      jobId: 'job:test',
      name: 'Test job',
      kind: 'recurring',
      status: 'paused',
      workspaceKey: 'main_agent',
      nextRun: null,
      lastRun: null,
      modelAlias: null,
      toolAccess: {
        inheritedAgentTools: [],
        effectiveAllowedTools: [],
        projectedRuntimeTools: [],
        source: 'inherited target agent capabilities',
      },
      setup: {
        state: 'missing_capability',
        deliveryNotice: {
          outcome: 'ambiguous',
          attempt: 1,
          text: 'A prompt may have been sent but could not be confirmed.',
        },
      },
    });

    expect(output).toContain(
      'Setup delivery: A prompt may have been sent but could not be confirmed.',
    );
  });

  it('renders setup.deliveryNotice in the shared scheduler formatter', () => {
    const output = schedulerJobSummary({
      id: 'job:test',
      name: 'Test job',
      status: 'paused',
      visibility: {
        setup: {
          state: 'missing_capability',
          deliveryNotice: {
            outcome: 'exhausted',
            attempt: 4,
            text: "We couldn't deliver the approval prompt after several attempts.",
          },
        },
      },
    });

    expect(output).toContain(
      "Setup delivery: We couldn't deliver the approval prompt after several attempts.",
    );
  });
});
