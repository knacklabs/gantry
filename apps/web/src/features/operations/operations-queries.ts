import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';
import { conversations, diagnostics, interactions } from './operations-preview';

export const operationsQueryKeys = {
  all: ['operations'] as const,
  providers: () => [...operationsQueryKeys.all, 'providers'] as const,
  mcpServers: () => [...operationsQueryKeys.all, 'mcp-servers'] as const,
  mcpEligibleAgents: (serverId: string, page: number, q: string) =>
    [
      ...operationsQueryKeys.mcpServers(),
      serverId,
      'eligible-agents',
      page,
      q,
    ] as const,
  skills: () => [...operationsQueryKeys.all, 'skills'] as const,
  skillFiles: (skillId: string) =>
    [...operationsQueryKeys.skills(), skillId, 'files'] as const,
  skillFile: (skillId: string, path: string) =>
    [...operationsQueryKeys.skillFiles(skillId), path] as const,
  conversations: () => [...operationsQueryKeys.all, 'conversations'] as const,
  interactions: () => [...operationsQueryKeys.all, 'interactions'] as const,
  diagnostics: () => [...operationsQueryKeys.all, 'diagnostics'] as const,
};

export type ModelProvider = {
  providerId: string;
  label: string;
  configured: boolean;
  health: 'ready' | 'missing' | 'disabled';
  authMode: string | null;
  configuredFields: string[];
  required: boolean;
  requiredBy: string[];
  supportedWorkloads: string[];
  updatedAt: string | null;
  credentialModes: Array<{
    id: string;
    label: string;
    helpText: string;
    fields: Array<{
      name: string;
      label: string;
      secret: boolean;
      required: boolean;
      multiline?: boolean;
    }>;
  }>;
};

export const modelProviderQuery = queryOptions({
  queryKey: operationsQueryKeys.providers(),
  queryFn: async (): Promise<ModelProvider[]> => {
    const response = await browserFetch('/ui/api/model-providers', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Model providers could not be loaded.');
    return ((await response.json()) as { providers: ModelProvider[] })
      .providers;
  },
});

export type McpServer = {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  status: 'active' | 'disabled';
  createdSource: 'admin' | 'agent_request';
  riskClass: 'low' | 'medium' | 'high';
  transport: 'http' | 'sse' | 'stdio_template';
  endpoint?: string;
  endpointHasParameters?: boolean;
  templateId?: string;
  args?: string[];
  allowedToolPatterns: string[];
  credentialRefs: Array<{
    name: string;
    target: 'env' | 'header';
    key: string;
  }>;
  networkHosts: string[];
  sandboxProfileId?: string;
  createdAt: string;
  updatedAt: string;
  bindings: Array<{
    agentId: string;
    name: string;
    binding: {
      status: string;
      required: boolean;
      allowedToolPatterns: string[];
    };
  }>;
};

export type McpInventory = {
  role: 'viewer' | 'administrator';
  servers: McpServer[];
  agents: Array<{ id: string; name: string }>;
};

export const mcpServerQuery = queryOptions({
  queryKey: operationsQueryKeys.mcpServers(),
  queryFn: async (): Promise<McpInventory> => {
    const response = await browserFetch('/ui/api/mcp-servers', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('MCP servers could not be loaded.');
    return (await response.json()) as McpInventory;
  },
});

export type McpEligibleAgent = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  attachment: 'attached' | 'eligible';
};

export type McpEligibleAgentsPage = {
  agents: McpEligibleAgent[];
  page: number;
  pageSize: number;
  total: number;
};

export function mcpEligibleAgentsQuery(
  serverId: string | undefined,
  page: number,
  q: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: operationsQueryKeys.mcpEligibleAgents(serverId ?? '', page, q),
    enabled: enabled && Boolean(serverId),
    queryFn: async (): Promise<McpEligibleAgentsPage> => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '25',
        ...(q.trim() ? { q: q.trim() } : {}),
      });
      const response = await browserFetch(
        `/ui/api/mcp-servers/${encodeURIComponent(serverId ?? '')}/eligible-agents?${params}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Eligible AI employees could not be loaded.');
      return (await response.json()) as McpEligibleAgentsPage;
    },
  });
}

export const conversationPreviewQuery = queryOptions({
  queryKey: operationsQueryKeys.conversations(),
  queryFn: () => conversations,
  initialData: conversations,
});

export const interactionPreviewQuery = queryOptions({
  queryKey: operationsQueryKeys.interactions(),
  queryFn: () => interactions,
  initialData: interactions,
});

export const diagnosticPreviewQuery = queryOptions({
  queryKey: operationsQueryKeys.diagnostics(),
  queryFn: () => diagnostics,
  initialData: diagnostics,
});
