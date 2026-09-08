import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';
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

export type BrowserPersonDirectoryItem = {
  id: string;
  kind: 'human' | 'service';
  displayName: string;
  status: 'active' | 'disabled' | 'archived';
  aliases: Array<{
    id: string;
    provider: string;
    displayName: string | null;
    verificationStatus: 'verified' | 'unverified' | 'retired';
  }>;
  aliasCounts: Partial<Record<'verified' | 'unverified' | 'retired', number>>;
  updatedAt: string;
};

export const peopleDirectoryQuery = queryOptions({
  queryKey: [...peopleQueryKeys.all, 'browser-list'] as const,
  queryFn: async (): Promise<{ people: BrowserPersonDirectoryItem[] }> => {
    const response = await browserFetch('/ui/api/people', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('People could not be loaded.');
    return response.json() as Promise<{ people: BrowserPersonDirectoryItem[] }>;
  },
});
