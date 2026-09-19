import { describe, expect, it } from 'vitest';

import {
  assertCandidateTransition,
  assertChallengeTransition,
  canCompleteOnboarding,
  earliestOnboardingStep,
} from '../../../src/application/onboarding/onboarding-state-machine.js';

describe('onboarding lifecycle', () => {
  it('resumes the earliest unfinished durable step', () => {
    expect(
      earliestOnboardingStep({
        agentId: 'agent:1',
        providerAccountId: 'account:1',
        conversationId: null,
        approverPersonId: null,
        state: 'setup_incomplete',
      }),
    ).toBe(3);
  });

  it('rejects shortcuts and requires durable ready state for completion', () => {
    expect(() => assertCandidateTransition('staged', 'activated')).toThrow();
    expect(() =>
      assertChallengeTransition('waiting_for_message', 'succeeded'),
    ).toThrow();
    expect(canCompleteOnboarding({ state: 'ready', readyAt: null })).toBe(
      false,
    );
    expect(
      canCompleteOnboarding({
        state: 'ready',
        readyAt: '2026-09-18T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('separates credential checking from model verification', () => {
    expect(() =>
      assertCandidateTransition('staged', 'validating'),
    ).not.toThrow();
    expect(() =>
      assertCandidateTransition('validating', 'checked'),
    ).not.toThrow();
    expect(() =>
      assertCandidateTransition('checked', 'validating'),
    ).not.toThrow();
    expect(() =>
      assertCandidateTransition('validating', 'verified'),
    ).not.toThrow();
    expect(() => assertCandidateTransition('checked', 'activated')).toThrow();
  });
});
