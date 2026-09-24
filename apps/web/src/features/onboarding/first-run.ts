import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';

export type OnboardingStatus = {
  completed: boolean;
  deployment: null | {
    id: string;
    version: number;
    state:
      | 'setup_incomplete'
      | 'projection_pending'
      | 'verification_required'
      | 'ready';
    step: 1 | 2 | 3 | 4;
    agentId: string | null;
    providerAccountId: string | null;
    conversationId: string | null;
    approverPersonId: string | null;
    desiredStateRevision: number | null;
    readyAt: string | null;
    modelCandidate: null | {
      id: string;
      providerId: string;
      authMode: string;
      state:
        | 'staged'
        | 'validating'
        | 'checked'
        | 'verified'
        | 'activated'
        | 'failed'
        | 'expired'
        | 'cancelled';
      modelAlias: string | null;
      expiresAt: string;
      verificationExpiresAt: string | null;
    };
  };
};

export const onboardingStatusQuery = queryOptions({
  queryKey: ['onboarding', 'status'],
  queryFn: async (): Promise<OnboardingStatus> => {
    const response = await browserFetch('/ui/api/onboarding/status', {
      credentials: 'same-origin',
    });
    if (!response.ok)
      throw new Error('Gantry could not check your onboarding status.');
    return response.json() as Promise<OnboardingStatus>;
  },
  retry: 3,
  retryDelay: (attempt) => [500, 1_000, 2_000][attempt] ?? 2_000,
});

export function onboardingCandidateModelsQuery(candidateId: string | null) {
  return queryOptions({
    queryKey: ['onboarding', 'model-candidates', candidateId, 'models'],
    enabled: Boolean(candidateId),
    queryFn: async (): Promise<{
      models: Array<{
        alias: string;
        displayName: string;
        providerId: string;
        supportedEffortLevels: string[];
      }>;
    }> => {
      const response = await browserFetch(
        `/ui/api/onboarding/model-candidates/${encodeURIComponent(candidateId!)}/models`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Gantry could not load models for these credentials.');
      return response.json() as Promise<{
        models: Array<{
          alias: string;
          displayName: string;
          providerId: string;
          supportedEffortLevels: string[];
        }>;
      }>;
    },
  });
}

async function completeOnboarding(expectedVersion: number) {
  const response = await browserFetch('/ui/api/onboarding/complete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      ...browserCsrfHeader(),
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ expectedVersion }),
  });
  if (!response.ok)
    throw new Error('Gantry could not save your onboarding progress.');
}

export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: completeOnboarding,
    onSuccess: () => {
      queryClient.setQueryData<OnboardingStatus>(
        onboardingStatusQuery.queryKey,
        (current) => ({
          completed: true,
          deployment: current?.deployment ?? null,
        }),
      );
    },
  });
}

export function useOnboardingEligibility() {
  const statusQuery = useQuery(onboardingStatusQuery);
  if (statusQuery.isPending)
    return { status: 'loading' as const, query: statusQuery };
  if (statusQuery.isError)
    return { status: 'fallback' as const, query: statusQuery };
  if (statusQuery.data.completed)
    return { status: 'complete' as const, query: statusQuery };
  return {
    status: 'onboarding' as const,
    query: statusQuery,
    onboarding: statusQuery.data,
  };
}
