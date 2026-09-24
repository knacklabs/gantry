import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';

import { agentModelsQuery } from '../agents/agents-queries';
import { invalidateProviderCredentialQueries } from './provider-availability';

it('refreshes the cached Roster model choices after a provider credential changes', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(agentModelsQuery.queryKey, {
    models: [
      {
        alias: 'gpt',
        displayName: 'GPT-5.5',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        configured: false,
      },
    ],
  });
  expect(client.getQueryState(agentModelsQuery.queryKey)?.isInvalidated).toBe(
    false,
  );

  await invalidateProviderCredentialQueries(client);

  expect(client.getQueryState(agentModelsQuery.queryKey)?.isInvalidated).toBe(
    true,
  );
});
