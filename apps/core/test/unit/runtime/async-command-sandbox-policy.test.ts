import { describe, expect, it } from 'vitest';

import { browserPolicyFromSemanticCapabilities } from '@core/runtime/async-command-sandbox-policy.js';

describe('async command browser policy', () => {
  it('enables recipe authoring for the selected semantic evaluator capability', () => {
    expect(
      browserPolicyFromSemanticCapabilities([
        {
          capabilityId: 'manipal.website-recipe-evaluator',
          version: '1',
          displayName: 'Website Recipe Evaluator',
          category: 'application',
          risk: 'write',
          can: 'Evaluate a candidate website recipe.',
          cannot: 'Access arbitrary Manipal interfaces.',
          credentialSource: 'configured_access',
          implementationBindings: [],
        },
      ]),
    ).toBe('recipe_authoring');
  });

  it('does not enable recipe authoring for unrelated capabilities', () => {
    expect(
      browserPolicyFromSemanticCapabilities([
        {
          capabilityId: 'source.discovery',
          version: '1',
          displayName: 'Source discovery',
          category: 'application',
          risk: 'read',
          can: 'Discover sources.',
          cannot: 'Author recipes.',
          credentialSource: 'configured_access',
          implementationBindings: [],
        },
      ]),
    ).toBeUndefined();
  });
});
