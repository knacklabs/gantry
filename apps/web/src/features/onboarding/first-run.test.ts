import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { firstRunAgentQuery, onboardingStatusQuery } from './first-run';

describe('first-run onboarding gate', () => {
  it('uses the existing agent directory with bounded retries', () => {
    expect(firstRunAgentQuery.queryKey).toEqual([
      'onboarding',
      'first-run-agent-count',
    ]);
    expect(firstRunAgentQuery.retry).toBe(3);
    const retryDelay = firstRunAgentQuery.retryDelay;
    expect(typeof retryDelay).toBe('function');
    if (typeof retryDelay !== 'function')
      throw new Error('Expected retry delay');
    expect(retryDelay(0, new Error())).toBe(500);
    expect(retryDelay(1, new Error())).toBe(1_000);
    expect(retryDelay(2, new Error())).toBe(2_000);
  });

  it('uses the authenticated completion endpoint instead of browser storage', () => {
    const gate = readFileSync('src/features/onboarding/first-run.ts', 'utf8');
    const route = readFileSync(
      'src/features/onboarding/onboarding-route.tsx',
      'utf8',
    );
    const overview = readFileSync(
      'src/features/operations/routes/overview-route.tsx',
      'utf8',
    );

    expect(onboardingStatusQuery.queryKey).toEqual(['onboarding', 'status']);
    expect(gate).toContain('/ui/api/agents?page=1&pageSize=1');
    expect(gate).toContain('/ui/api/onboarding/status');
    expect(gate).toContain('/ui/api/onboarding/complete');
    expect(gate).toContain("query.data.data[0]?.id === 'agent:main_agent'");
    expect(gate).not.toContain('localStorage');
    expect(route).toContain("navigate({ to: '/overview' })");
    expect(route).not.toContain("eligibility.status === 'console'");
    expect(overview).toContain('Dismiss onboarding reminder');
    expect(overview).toContain('Do you want to complete onboarding?');
    expect(overview).toContain('to="/onboarding"');
    expect(route).not.toContain('fetch(');
    expect(route).not.toContain('onContinue={next}');
    expect(route).toContain('<AssignWorkStep');
    expect(
      readFileSync(
        'src/features/onboarding/components/onboarding-footer.tsx',
        'utf8',
      ),
    ).toContain("step === 4 ? 'Open the console' : 'Continue'");
  });
});
