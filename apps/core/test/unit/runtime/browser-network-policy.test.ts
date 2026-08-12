import { describe, expect, it } from 'vitest';

import { browserNavigationHostAllowed } from '@core/runtime/browser-network-policy.js';

describe('browser network policy', () => {
  it('allows only exact or explicitly wildcarded recipe navigation hosts', () => {
    const allowed = ['tenders.example.gov', '*.documents.example.gov'];
    expect(browserNavigationHostAllowed('tenders.example.gov', allowed)).toBe(
      true,
    );
    expect(
      browserNavigationHostAllowed('cdn.documents.example.gov', allowed),
    ).toBe(true);
    expect(browserNavigationHostAllowed('example.gov', allowed)).toBe(false);
    expect(
      browserNavigationHostAllowed('tenders.example.gov.evil.test', allowed),
    ).toBe(false);
  });
});
