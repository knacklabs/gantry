import { queryOptions } from '@tanstack/react-query';

import { agents, sources } from './agents-preview';

export const agentQueryKeys = {
  all: ['agents'] as const,
  list: () => [...agentQueryKeys.all, 'list'] as const,
  sources: () => [...agentQueryKeys.all, 'sources'] as const,
};

export const agentPreviewQuery = queryOptions({
  queryKey: agentQueryKeys.list(),
  queryFn: () => agents,
  initialData: agents,
});

export const sourcePreviewQuery = queryOptions({
  queryKey: agentQueryKeys.sources(),
  queryFn: () => sources,
  initialData: sources,
});
