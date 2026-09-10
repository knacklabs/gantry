import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isBrowserOnboardingPath } from '@core/control/server/routes/browser-onboarding.js';

const repoRoot = path.resolve(
  new URL('../../../../../..', import.meta.url).pathname,
);
const source = fs.readFileSync(
  path.join(
    repoRoot,
    'apps/core/src/control/server/routes/browser-onboarding.ts',
  ),
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
    expect(source).toMatch(
      /const onboardingAgents = agents\.filter\(\s*\(agent\) => agent\.id !== DEFAULT_AGENT_ID,?\s*\);/,
    );
    expect(source).toContain('firstRun: onboardingAgents.length === 0');
  });

  it('requires a real conversation installation before issuing a challenge', () => {
    expect(source).toContain('isAgentEnabledInConversation({');
    expect(source).toContain(
      'Install this employee in the selected conversation before verifying it.',
    );
  });

  it('uses durable setup records and omits completed verification from resume', () => {
    expect(source).toContain('onboardingSetupsPostgres');
    expect(source).toContain('const setupAgentIds = new Set(');
    expect(source).toContain(
      "if (verification?.status === 'completed') return null;",
    );
    expect(source).toContain("verification?.status === 'pending'");
  });

  it('generates challenge codes at the server trust boundary', () => {
    expect(source).toContain(
      "const challenge = `GY-${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;",
    );
    expect(source).not.toContain('payload.challenge');
  });
});
