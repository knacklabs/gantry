import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled']),
  agentHarness: z.enum(['auto', 'anthropic_sdk', 'deepagents']),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const agentsSchema = z.object({ agents: z.array(agentSchema) });

const profileFileSchema = z.object({
  agentId: z.string(),
  kind: z.literal('soul'),
  path: z.string(),
  version: z.number().int(),
  contentHash: z.string(),
  content: z.string(),
});

export type LiveAgent = z.infer<typeof agentSchema> & {
  setupState?: 'draft';
};

export async function loadAgents(
  transport: RuntimeApiTransport,
): Promise<LiveAgent[]> {
  const result = await transport.request({
    path: '/agents',
    schema: agentsSchema,
  });
  return result.agents.map((agent) => ({
    ...agent,
    setupState: agent.metadata?.setupState === 'draft' ? 'draft' : undefined,
  }));
}

export function loadAgent(transport: RuntimeApiTransport, agentId: string) {
  return transport.request({
    path: `/agents/${encodeURIComponent(agentId)}`,
    schema: agentSchema,
  });
}

export function updateAgent(
  transport: RuntimeApiTransport,
  agentId: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: 'active' | 'disabled';
    agentHarness?: 'auto' | 'anthropic_sdk' | 'deepagents';
  },
) {
  return transport.request({
    path: `/agents/${encodeURIComponent(agentId)}`,
    method: 'PATCH',
    body: patch,
    schema: agentSchema,
  });
}

export function loadAgentSoul(
  transport: RuntimeApiTransport,
  agentId: string,
) {
  return transport.request({
    path: `/agents/${encodeURIComponent(agentId)}/profile-files/soul`,
    schema: profileFileSchema,
  });
}

export function updateAgentSoul(
  transport: RuntimeApiTransport,
  agentId: string,
  input: { content: string; expectedVersion: number },
) {
  return transport.request({
    path: `/agents/${encodeURIComponent(agentId)}/profile-files/soul`,
    method: 'PUT',
    body: input,
    schema: profileFileSchema,
  });
}
