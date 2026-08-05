import { queryOptions } from '@tanstack/react-query';

import { mergeHistory, people } from './people-preview';

export const peopleQueryKeys = {
  all: ['people'] as const,
  list: () => [...peopleQueryKeys.all, 'list'] as const,
  mergeHistory: () => [...peopleQueryKeys.all, 'merge-history'] as const,
};

export const peoplePreviewQuery = queryOptions({
  queryKey: peopleQueryKeys.list(),
  queryFn: () => people,
  initialData: people,
});

export const mergeHistoryPreviewQuery = queryOptions({
  queryKey: peopleQueryKeys.mergeHistory(),
  queryFn: () => mergeHistory,
  initialData: mergeHistory,
});
