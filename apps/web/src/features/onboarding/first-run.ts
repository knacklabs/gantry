import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';

import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';
import { toast } from '../../ui/primitives/toast';

type AgentPage = { total: number };
type OnboardingStatus = { completed: boolean };

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

export const firstRunAgentQuery = queryOptions({
  queryKey: ['onboarding', 'first-run-agent-count'],
  queryFn: async (): Promise<AgentPage> => {
    const response = await browserFetch('/ui/api/agents?page=1&pageSize=1', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Gantry could not check your setup.');
    return response.json() as Promise<AgentPage>;
  },
  retry: 3,
  retryDelay: (attempt) => [500, 1_000, 2_000][attempt] ?? 2_000,
});

async function completeOnboarding() {
  const response = await browserFetch('/ui/api/onboarding/complete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: browserCsrfHeader(),
  });
  if (!response.ok)
    throw new Error('Gantry could not save your onboarding progress.');
}

export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: completeOnboarding,
    onSuccess: () => {
      queryClient.setQueryData(onboardingStatusQuery.queryKey, {
        completed: true,
      });
    },
  });
}

export function useOnboardingEligibility() {
  const statusQuery = useQuery(onboardingStatusQuery);
  const query = useQuery({
    ...firstRunAgentQuery,
    enabled: statusQuery.data?.completed === false,
  });

  useEffect(() => {
    if (!statusQuery.isError && !query.isError) return;
    toast.error('Could not confirm whether Gantry already has an employee.', {
      id: 'onboarding-agent-check',
      action: {
        label: 'Retry',
        onClick: () =>
          void Promise.all([statusQuery.refetch(), query.refetch()]),
      },
    });
  }, [query.isError, query.refetch, statusQuery.isError, statusQuery.refetch]);

  if (statusQuery.isPending) return { status: 'loading' as const, query };
  if (statusQuery.isError || query.isError)
    return { status: 'fallback' as const, query };
  if (statusQuery.data.completed) return { status: 'complete' as const, query };
  if (query.isPending) return { status: 'loading' as const, query };
  return {
    status:
      query.data.total === 0 ? ('onboarding' as const) : ('console' as const),
    query,
  };
}
