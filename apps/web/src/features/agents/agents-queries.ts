import { queryOptions } from '@tanstack/react-query';

import { agents, sources } from './agents-preview';

export const agentQueryKeys = {
  all: ['agents'] as const,
  list: () => [...agentQueryKeys.all, 'list'] as const,
  sources: () => [...agentQueryKeys.all, 'sources'] as const,
};

export const sourcePreviewQuery = queryOptions({
  queryKey: agentQueryKeys.sources(),
  queryFn: () => sources,
  initialData: sources,
});

// Temporary consumer for routes which have not yet moved to the live Agent API.
export const agentPreviewQuery = queryOptions({
  queryKey: [...agentQueryKeys.list(), 'legacy-preview'] as const,
  queryFn: () => agents,
  initialData: agents,
});
