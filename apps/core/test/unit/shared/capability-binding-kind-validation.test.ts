import { expect, it } from 'vitest';

import { semanticCapabilityFromToolCatalogItem } from '@core/shared/semantic-capabilities.js';

it('rejects an unknown kind in a stored capability definition', () => {
  expect(
    semanticCapabilityFromToolCatalogItem({
      name: 'capability:example.records.read',
      inputSchema: {
        format: 'gantry.semantic-capability.v1',
        schema: {
          capabilityId: 'example.records.read',
          displayName: 'Example records read',
          category: 'Example',
          risk: 'read',
          can: 'Read records.',
          cannot: 'Change records.',
          credentialSource: 'none',
          implementationBindings: [{ kind: 'unknown_kind' }],
        },
      },
    }),
  ).toBeUndefined();
});
