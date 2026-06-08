import { describe, expect, it } from 'vitest';

import { setupActionLabel } from '@core/shared/job-setup-labels.js';

describe('job setup labels', () => {
  it('uses the review action for unreviewed semantic capabilities', () => {
    expect(
      setupActionLabel({
        state: 'missing_capability',
        requirementType: 'semantic_capability',
        requirementId: 'acme.records.append',
        nextAction:
          'Refresh attached source inventory, then update the job to a reviewed source-neutral capability from capability_search.',
      }),
    ).toBe(
      'Refresh attached source inventory, then update the job to a reviewed source-neutral capability from capability_search.',
    );
  });

  it('keeps approve wording for reviewed semantic capabilities', () => {
    expect(
      setupActionLabel({
        state: 'missing_capability',
        requirementType: 'semantic_capability',
        requirementId: 'acme.records.append',
        nextAction:
          'propose_capability {"capabilityId":"acme.records.append","reason":"Append reviewed records."}',
      }),
    ).toBe('Approve Acme Records Append, then resume the job.');
  });
});
