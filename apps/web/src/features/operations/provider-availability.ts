import type { QueryClient } from '@tanstack/react-query';

import { agentModelsQuery } from '../agents/agents-queries';
import { navigationSummaryQuery } from '../navigation/navigation-summary-query';
import { modelProviderQuery } from './operations-queries';

export async function invalidateProviderCredentialQueries(
  queryClient: QueryClient,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: modelProviderQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: agentModelsQuery.queryKey }),
    queryClient.invalidateQueries({
      queryKey: navigationSummaryQuery.queryKey,
    }),
  ]);
}
