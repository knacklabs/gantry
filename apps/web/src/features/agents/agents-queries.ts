import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';

export const agentQueryKeys = {
  all: ['agents'] as const,
  list: () => [...agentQueryKeys.all, 'list'] as const,
};

export type AgentDirectoryItem = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  roleId: string | null;
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

export type AgentModel = {
  alias: string;
  displayName: string;
  providerId: string;
  providerLabel: string;
};

export const agentModelsQuery = queryOptions({
  queryKey: [...agentQueryKeys.all, 'models'] as const,
  queryFn: async (): Promise<{ models: AgentModel[] }> => {
    const response = await browserFetch('/ui/api/agent-models', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Models could not be loaded.');
    return response.json() as Promise<{ models: AgentModel[] }>;
  },
});

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
  retainedAgentCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

type SourceStatus = 'installed' | 'active' | 'disabled';

export type AgentSource = {
  skills: Array<{ id: string; name?: string; status?: SourceStatus }>;
  mcpServers: Array<{
    id: string;
    name?: string;
    status?: SourceStatus;
    tools?: string[];
  }>;
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
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    status: 'installed';
  }>;
  mcpServers?: Array<{
    id: string;
    name: string;
    displayName?: string;
    description?: string;
    status: 'active' | 'disabled';
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

export function agentCatalogQuery(
  agentId: string,
  endpoint: 'sources' | 'capabilities',
  catalog: 'skills' | 'mcp' | 'capabilities',
  search: string,
  page: number,
) {
  return queryOptions({
    queryKey: [
      ...agentQueryKeys.all,
      'catalog',
      agentId,
      endpoint,
      catalog,
      search,
      page,
    ] as const,
    queryFn: async (): Promise<{
      catalog: BrowserPage<
        | NonNullable<CapabilityCatalog['skills']>[number]
        | NonNullable<CapabilityCatalog['mcpServers']>[number]
        | NonNullable<CapabilityCatalog['capabilities']>[number]
      >;
    }> => {
      const params = new URLSearchParams({
        catalog,
        page: String(page),
        pageSize: '25',
      });
      if (search) params.set('search', search);
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/${endpoint}?${params}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error('Catalog could not be loaded.');
      return response.json() as Promise<{
        catalog: BrowserPage<
          | NonNullable<CapabilityCatalog['skills']>[number]
          | NonNullable<CapabilityCatalog['mcpServers']>[number]
          | NonNullable<CapabilityCatalog['capabilities']>[number]
        >;
      }>;
    },
  });
}

export type AgentVersion = {
  id: string;
  version: number;
  createdAt: string;
  agentNameSnapshot?: string;
  roleSnapshot?: { displayName: string; prompt: string; sourceRoleId?: string };
  modelAliasSnapshot?: string | null;
  llmProfileId: string;
};

export function agentVersionsQuery(agentId: string) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'versions', agentId] as const,
    queryFn: async (): Promise<{ versions: AgentVersion[] }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/versions`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error('Version history could not be loaded.');
      return response.json() as Promise<{ versions: AgentVersion[] }>;
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

export function roleDirectoryQuery(input: {
  page: number;
  pageSize?: number;
  search: string;
  kind?: 'all' | 'built-in' | 'custom';
}) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'roles', input] as const,
    queryFn: async (): Promise<BrowserPage<BrowserRole>> => {
      const params = new URLSearchParams({
        page: String(input.page),
        pageSize: String(input.pageSize ?? 25),
      });
      if (input.search) params.set('search', input.search);
      if (input.kind && input.kind !== 'all') params.set('kind', input.kind);
      const response = await browserFetch(`/ui/api/roles?${params}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Roles could not be loaded.');
      return response.json() as Promise<BrowserPage<BrowserRole>>;
    },
  });
}
