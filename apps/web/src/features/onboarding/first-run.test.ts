import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { firstRunAgentQuery, ONBOARDING_COMPLETE_KEY } from './first-run';

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

  it('keeps completion browser-local and setup actions transport-free', () => {
    const gate = readFileSync('src/features/onboarding/first-run.ts', 'utf8');
    const route = readFileSync(
      'src/features/onboarding/onboarding-route.tsx',
      'utf8',
    );

    expect(ONBOARDING_COMPLETE_KEY).toBe('gantry.onboarding.ui-v2-complete');
    expect(gate).toContain('/ui/api/agents?page=1&pageSize=1');
    expect(gate).toContain(
      "localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true')",
    );
    expect(route).toContain("navigate({ to: '/overview' })");
    expect(route).not.toContain('fetch(');
  });
});
