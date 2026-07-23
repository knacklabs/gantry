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
