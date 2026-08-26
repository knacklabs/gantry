import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';

export const agentQueryKeys = {
  all: ['agents'] as const,
  list: () => [...agentQueryKeys.all, 'list'] as const,
  sources: () => [...agentQueryKeys.all, 'sources'] as const,
};

export type AgentDirectoryItem = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  roleName: string | null;
  rolePrompt: string | null;
  configVersion: number | null;
  modelAlias: string | null;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
};

export type BrowserPage<T> = {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
};

export type AgentDirectoryPage = BrowserPage<AgentDirectoryItem>;

export function agentDetailQuery(agentId: string) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'detail', agentId] as const,
    queryFn: async (): Promise<{ agent: AgentDirectoryItem }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error('Agent could not be loaded.');
      return response.json() as Promise<{ agent: AgentDirectoryItem }>;
    },
  });
}

export type BrowserRole = {
  id: string;
  name: string;
  prompt: string;
  kind: 'built-in' | 'custom';
  sourceRoleId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AgentSource = {
  skills: Array<{ id: string; name?: string }>;
  mcpServers: Array<{ id: string; tools?: string[] }>;
  tools: Array<{ id: string; kind: string; version?: string }>;
};

export type CapabilityCatalog = {
  capabilities?: Array<{
    id: string;
    version: string;
    label: string;
    description?: string;
    risk: 'low' | 'medium' | 'high';
  }>;
  skills?: Array<{ id: string; name: string; description?: string }>;
  mcpServers?: Array<{
    id: string;
    name: string;
    displayName?: string;
    description?: string;
  }>;
};

export type AgentCapabilities = {
  sources: AgentSource;
  capabilities: Array<{ id: string; version: string }>;
  summary: { capabilities: number; [key: string]: unknown };
};

export function agentSourcesQuery(agentId: string) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'sources', agentId] as const,
    queryFn: async (): Promise<{
      sources: { sources: AgentSource };
      catalog: CapabilityCatalog;
    }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/sources`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error('Agent sources could not be loaded.');
      return response.json() as Promise<{
        sources: { sources: AgentSource };
        catalog: CapabilityCatalog;
      }>;
    },
  });
}

export function agentCapabilitiesQuery(agentId: string) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'capabilities', agentId] as const,
    queryFn: async (): Promise<{
      capabilities: AgentCapabilities;
      catalog: CapabilityCatalog;
    }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/capabilities`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Agent capabilities could not be loaded.');
      return response.json() as Promise<{
        capabilities: AgentCapabilities;
        catalog: CapabilityCatalog;
      }>;
    },
  });
}

export function agentDirectoryQuery(input: {
  page: number;
  pageSize: number;
  search: string;
  status: string;
  role: string;
  sort: string;
  direction: 'asc' | 'desc';
}) {
  return queryOptions({
    queryKey: [...agentQueryKeys.list(), input] as const,
    queryFn: async (): Promise<AgentDirectoryPage> => {
      const params = new URLSearchParams({
        page: String(input.page),
        pageSize: String(input.pageSize),
        sort: input.sort,
        direction: input.direction,
      });
      if (input.search) params.set('search', input.search);
      if (input.status !== 'all') params.set('status', input.status);
      if (input.role !== 'all') params.set('role', input.role);
      const response = await browserFetch(`/ui/api/agents?${params}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Agents could not be loaded.');
      return response.json() as Promise<AgentDirectoryPage>;
    },
  });
}

export function roleDirectoryQuery(input: { page: number; search: string }) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'roles', input] as const,
    queryFn: async (): Promise<BrowserPage<BrowserRole>> => {
      const params = new URLSearchParams({
        page: String(input.page),
        pageSize: '25',
      });
      if (input.search) params.set('search', input.search);
      const response = await browserFetch(`/ui/api/roles?${params}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Roles could not be loaded.');
      return response.json() as Promise<BrowserPage<BrowserRole>>;
    },
  });
}
