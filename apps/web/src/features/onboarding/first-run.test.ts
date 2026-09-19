import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { onboardingStatusQuery } from './first-run';

describe('first-run onboarding gate', () => {
  it('loads durable onboarding progress with bounded retries', () => {
    expect(onboardingStatusQuery.queryKey).toEqual(['onboarding', 'status']);
    expect(onboardingStatusQuery.retry).toBe(3);
    const retryDelay = onboardingStatusQuery.retryDelay;
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
    expect(gate).toContain('/ui/api/onboarding/status');
    expect(gate).toContain('/ui/api/onboarding/complete');
    expect(gate).not.toContain('localStorage');
    expect(route).toContain("navigate({ to: '/overview' })");
    expect(route).not.toContain("eligibility.status === 'console'");
    expect(overview).toContain('<Navigate replace to="/onboarding" />');
    expect(route).not.toContain('fetch(');
    expect(route).not.toContain('onContinue={next}');
    expect(route).toContain('<AssignWorkStep');
    const footer = readFileSync(
      'src/features/onboarding/components/onboarding-footer.tsx',
      'utf8',
    );
    expect(footer).toContain("'Open the console'");
    expect(footer).toContain("'Continue'");
    expect(footer).toContain("'Saving…'");
  });

  it('derives step-one credential methods from the provider registry', () => {
    const step = readFileSync(
      'src/features/onboarding/steps/create-employee-step.tsx',
      'utf8',
    );

    expect(step).toContain('Google Vertex AI');
    expect(step).toContain('modelProviderQuery');
    expect(step).toContain('setup?.credentialModes');
    expect(step).toContain('Check credentials');
    expect(step).toContain('Checking credentials…');
    expect(step).toContain('Credentials checked');
    expect(step).toContain('Test model');
    expect(step).toContain('Testing model…');
    expect(step).toContain('Model verified');
    expect(step).toContain('disabled={!credentialsChecked || pending}');
    expect(step).not.toContain('onboarding-validation-checks');
    expect(step).not.toContain('browserFetch');
    expect(step).not.toContain('fetch(');
  });
});
