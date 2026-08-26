import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';
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

export type AgentDirectoryItem = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
};

export type AgentDirectoryPage = {
  items: AgentDirectoryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export function agentDirectoryQuery(input: {
  page: number;
  search: string;
  status: string;
}) {
  return queryOptions({
    queryKey: [...agentQueryKeys.list(), input] as const,
    queryFn: async (): Promise<AgentDirectoryPage> => {
      const params = new URLSearchParams({
        page: String(input.page),
        pageSize: '25',
      });
      if (input.search) params.set('search', input.search);
      if (input.status !== 'all') params.set('status', input.status);
      const response = await browserFetch(`/ui/api/agents?${params}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Agents could not be loaded.');
      return response.json() as Promise<AgentDirectoryPage>;
    },
  });
}

export const sourcePreviewQuery = queryOptions({
  queryKey: agentQueryKeys.sources(),
  queryFn: () => sources,
  initialData: sources,
});
