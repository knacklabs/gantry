export const ONBOARDING_CANDIDATE_TTL_MS = 30 * 60_000;
export const ONBOARDING_VERIFICATION_TTL_MS = 10 * 60_000;
export const ONBOARDING_MODEL_PROBE_TIMEOUT_MS = 60_000;

export type OnboardingDeploymentState =
  | 'setup_incomplete'
  | 'projection_pending'
  | 'verification_required'
  | 'ready';

export type OnboardingCandidateState =
  | 'staged'
  | 'validating'
  | 'checked'
  | 'verified'
  | 'activated'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type OnboardingChallengeState =
  | 'waiting_for_message'
  | 'queued'
  | 'running'
  | 'awaiting_delivery'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'superseded';

const candidateTransitions: Record<
  OnboardingCandidateState,
  readonly OnboardingCandidateState[]
> = {
  staged: ['validating', 'cancelled', 'expired'],
  validating: ['checked', 'verified', 'failed', 'cancelled', 'expired'],
  checked: ['validating', 'cancelled', 'expired'],
  verified: ['validating', 'activated', 'cancelled', 'expired'],
  activated: [],
  failed: [],
  expired: [],
  cancelled: [],
};

const challengeTransitions: Record<
  OnboardingChallengeState,
  readonly OnboardingChallengeState[]
> = {
  waiting_for_message: ['queued', 'failed', 'expired', 'superseded'],
  queued: ['running', 'failed', 'expired', 'superseded'],
  running: ['awaiting_delivery', 'failed', 'expired', 'superseded'],
  awaiting_delivery: ['succeeded', 'failed', 'expired', 'superseded'],
  succeeded: [],
  failed: [],
  expired: [],
  superseded: [],
};

export function assertCandidateTransition(
  current: OnboardingCandidateState,
  next: OnboardingCandidateState,
): void {
  if (!candidateTransitions[current].includes(next)) {
    throw new Error(
      `Invalid onboarding candidate transition: ${current} -> ${next}`,
    );
  }
}

export function assertChallengeTransition(
  current: OnboardingChallengeState,
  next: OnboardingChallengeState,
): void {
  if (!challengeTransitions[current].includes(next)) {
    throw new Error(
      `Invalid onboarding challenge transition: ${current} -> ${next}`,
    );
  }
}

export function earliestOnboardingStep(input: {
  agentId: string | null;
  providerAccountId: string | null;
  conversationId: string | null;
  approverPersonId: string | null;
  state: OnboardingDeploymentState;
}): 1 | 2 | 3 | 4 {
  if (!input.agentId) return 1;
  if (!input.providerAccountId) return 2;
  if (!input.conversationId || !input.approverPersonId) return 3;
  return 4;
}

export function canCompleteOnboarding(input: {
  state: OnboardingDeploymentState;
  readyAt: string | null;
}): boolean {
  return input.state === 'ready' && Boolean(input.readyAt);
}
