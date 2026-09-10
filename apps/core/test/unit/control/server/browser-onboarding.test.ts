import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isBrowserOnboardingPath } from '@core/control/server/routes/browser-onboarding.js';

const repoRoot = path.resolve(
  new URL('../../../../../..', import.meta.url).pathname,
);
const source = fs.readFileSync(
  path.join(repoRoot, 'apps/core/src/control/server/routes/browser-onboarding.ts'),
  'utf8',
);

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

  it('does not mistake the runtime seed agent for an onboarded employee', () => {
    expect(source).toContain('DEFAULT_AGENT_ID');
    expect(source).toContain(
      'const onboardingAgents = agents.filter((agent) => agent.id !== DEFAULT_AGENT_ID);',
    );
    expect(source).toContain('firstRun: onboardingAgents.length === 0');
  });
});
