import { describe, expect, it } from 'vitest';

import { parseSetupState } from '@core/adapters/storage/postgres/services/canonical-job-target-state.js';

describe('canonical job setup state', () => {
  it('retains an exact-skill readiness blocker', () => {
    expect(
      parseSetupState({
        state: 'missing_capability',
        checked_at: '2026-08-16T18:08:25.759Z',
        fingerprint: 'skill-blocker',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'skill',
            requirementId: 'manipal-tender-website-recipe',
            message: 'This job requires the exact reviewed skill revision.',
            nextAction: 'Install and bind the exact skill artifact.',
          },
        ],
      }),
    ).toMatchObject({
      state: 'missing_capability',
      blockers: [
        {
          requirementType: 'skill',
          requirementId: 'manipal-tender-website-recipe',
        },
      ],
    });
  });
});
