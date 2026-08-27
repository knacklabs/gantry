import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';

export type NavigationSummary = {
  agents: {
    total: number;
    active: number;
    disabled: number;
    withoutRole: number;
  };
  mcpServers: { active: number; disabled: number };
  modelProviders: { ready: number; missing: number; disabled: number };
};

export const navigationSummaryQuery = queryOptions({
  queryKey: ['navigation-summary'],
  queryFn: async (): Promise<NavigationSummary> => {
    const response = await browserFetch('/ui/api/navigation-summary', {
      credentials: 'same-origin',
    });
    if (!response.ok)
      throw new Error('Navigation summary could not be loaded.');
    return response.json() as Promise<NavigationSummary>;
  },
  refetchInterval: 60_000,
  refetchOnWindowFocus: true,
  retry: 1,
});
