import { describe, expect, it } from 'vitest';

import { isBrowserOnboardingPath } from '@core/control/server/routes/browser-onboarding.js';

describe('browser onboarding route', () => {
  it('matches only the onboarding status endpoint', () => {
    expect(isBrowserOnboardingPath('/ui/api/onboarding/status')).toBe(true);
    expect(isBrowserOnboardingPath('/ui/api/onboarding/verifications')).toBe(
      true,
    );
    expect(
      isBrowserOnboardingPath(
        '/ui/api/onboarding/verifications/onboarding-verification:one',
      ),
    ).toBe(true);
    expect(isBrowserOnboardingPath('/ui/api/onboarding')).toBe(false);
  });
});
