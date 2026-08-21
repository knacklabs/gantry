import { z } from 'zod';

export const agentListSearchSchema = z.object({
  q: z.string().catch(''),
  status: z
    .enum(['all', 'deployed', 'draft', 'paused', 'blocked'])
    .catch('all'),
  model: z.enum(['all', 'sonnet', 'opus', 'gpt-5']).catch('all'),
  page: z.coerce.number().int().min(1).catch(1),
  sort: z.enum(['name', 'status', 'modelAlias', 'lastRun']).catch('name'),
  desc: z.coerce.boolean().catch(false),
});

export const agentDetailSearchSchema = z.object({
  tab: z
    .enum([
      'identity',
      'profile',
      'sources',
      'capabilities',
      'skills',
      'mcp',
      'access',
      'conversations',
    ])
    .catch('identity'),
});

export const sourceSearchSchema = z.object({
  q: z.string().catch(''),
  kind: z
    .enum(['all', 'Built-in tools', 'Skill catalog', 'MCP server', 'Local CLI'])
    .catch('all'),
  selected: z.string().optional().catch(undefined),
});
