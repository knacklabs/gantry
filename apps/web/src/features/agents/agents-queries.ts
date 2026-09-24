import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';

export const agentQueryKeys = {
  all: ['agents'] as const,
  list: () => [...agentQueryKeys.all, 'list'] as const,
};

export type AgentDirectoryItem = {
  id: string;
  name: string;
  status: 'active' | 'disabled' | 'offboarded';
  roleId: string | null;
  roleName: string | null;
  rolePrompt: string | null;
  configVersion: number | null;
  modelAlias: string | null;
  modelDisplayName?: string | null;
  modelProviderId?: string | null;
  modelProviderLabel?: string | null;
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

export type AgentPersona = {
  content: string;
  version: number;
  isDefault: boolean;
};

export type AgentProfileSection = 'persona' | 'instructions';

export function agentProfileQuery(
  agentId: string,
  section: AgentProfileSection,
) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, section, agentId] as const,
    queryFn: async (): Promise<Record<AgentProfileSection, AgentPersona>> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/${section}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error('Profile could not be loaded.');
      return response.json() as Promise<
        Record<AgentProfileSection, AgentPersona>
      >;
    },
  });
}

export function agentPersonaQuery(agentId: string) {
  return agentProfileQuery(agentId, 'persona');
}

export type AgentWorkflowRelationship =
  | {
      id: string;
      kind: 'conversation';
      title: string;
      providerLabel: string;
      status: string;
    }
  | {
      id: string;
      kind: 'job';
      name: string;
      schedule: string;
      status: string;
      nextRun: string | null;
    }
  | {
      id: string;
      kind: 'model';
      alias: string;
      displayName: string;
      provider: string;
    }
  | {
      id: string;
      kind: 'skill' | 'mcp_server';
      name: string;
      sourceStatus: string;
    }
  | {
      id: string;
      kind: 'approver';
      displayName: string;
      conversationId: string;
      conversation: string;
    };

export type AgentWorkflowMap = { relationships: AgentWorkflowRelationship[] };

export function agentWorkflowMapQuery(agentId: string) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'workflow-map', agentId] as const,
    queryFn: async (): Promise<AgentWorkflowMap> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/workflow-map`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Employee workflow could not be loaded.');
      return response.json() as Promise<AgentWorkflowMap>;
    },
  });
}

export type AgentModel = {
  alias: string;
  displayName: string;
  providerId: string;
  providerLabel: string;
  configured: boolean;
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
      if (!response.ok) throw new Error('AI employee could not be loaded.');
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
    category?: string;
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
    status: 'active' | 'disabled' | 'offboarded';
  }>;
};

export type AgentCapabilities = {
  capabilities: Array<{ id: string; version: string }>;
};

export function agentSourcesQuery(agentId: string) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'sources', agentId] as const,
    queryFn: async (): Promise<{ sources: { sources: AgentSource } }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/sources`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) {
        throw new Error('AI employee sources could not be loaded.');
      }
      return response.json() as Promise<{ sources: { sources: AgentSource } }>;
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
        throw new Error('AI employee capabilities could not be loaded.');
      return response.json() as Promise<{
        capabilities: AgentCapabilities;
        catalog: CapabilityCatalog;
      }>;
    },
  });
}

export function agentAuditQuery(agentId: string, page: number) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'audit', agentId, page] as const,
    enabled: Boolean(agentId),
    queryFn: async (): Promise<{
      events: Array<{
        eventId: number;
        eventType: string;
        actor:
          | { kind: 'human'; personId: string; aliasId?: string }
          | { kind: 'service'; personId: string; aliasId?: string }
          | { kind: 'system'; source: string };
        conversationId: string | null;
        createdAt: string;
      }>;
      page: number;
      pageSize: number;
      hasNext: boolean;
    }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/audit?page=${page}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('AI employee audit could not be loaded.');
      return response.json() as Promise<{
        events: Array<{
          eventId: number;
          eventType: string;
          actor:
            | { kind: 'human'; personId: string; aliasId?: string }
            | { kind: 'service'; personId: string; aliasId?: string }
            | { kind: 'system'; source: string };
          conversationId: string | null;
          createdAt: string;
        }>;
        page: number;
        pageSize: number;
        hasNext: boolean;
      }>;
    },
  });
}

export function agentUsageQuery(
  agentId: string,
  range: 'seven_days' | 'today',
) {
  return queryOptions({
    queryKey: [...agentQueryKeys.all, 'usage', agentId, range] as const,
    enabled: Boolean(agentId),
    queryFn: async (): Promise<{
      usage: Array<{
        day?: string;
        requestCount: number;
        inputTokens: number;
        outputTokens: number;
      }>;
    }> => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/usage?range=${range === 'today' ? 'today' : 'seven_days'}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('AI employee usage could not be loaded.');
      return response.json() as Promise<{
        usage: Array<{
          day?: string;
          requestCount: number;
          inputTokens: number;
          outputTokens: number;
        }>;
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
      if (!response.ok) throw new Error('AI employees could not be loaded.');
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
