import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { browserFetch } from '../../lib/auth/browser-auth';
import { toast } from '../../ui/primitives/toast';

export const ONBOARDING_COMPLETE_KEY = 'gantry.onboarding.ui-v2-complete';

type AgentPage = { total: number };

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

export function hasCompletedOnboarding() {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function completeOnboarding() {
  try {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
  } catch {
    // A private browser can still enter the console for this visit.
  }
}

export function useOnboardingEligibility() {
  const completed = hasCompletedOnboarding();
  const query = useQuery({ ...firstRunAgentQuery, enabled: !completed });

  useEffect(() => {
    if (!query.isError) return;
    toast.error('Could not confirm whether Gantry already has an employee.', {
      id: 'onboarding-agent-check',
      action: { label: 'Retry', onClick: () => void query.refetch() },
    });
  }, [query.isError, query.refetch]);

  if (completed) return { status: 'complete' as const, query };
  if (query.isPending) return { status: 'loading' as const, query };
  if (query.isError) return { status: 'fallback' as const, query };
  return {
    status:
      query.data.total === 0 ? ('onboarding' as const) : ('console' as const),
    query,
  };
}
