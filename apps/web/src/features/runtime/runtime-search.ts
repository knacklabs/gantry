import { z } from 'zod';

export const jobSearchSchema = z.object({
  q: z.string().catch(''),
  status: z.enum(['all', 'enabled', 'paused', 'blocked']).catch('all'),
  page: z.coerce.number().int().min(1).catch(1),
  sort: z.enum(['name', 'status', 'agent', 'nextRun']).catch('name'),
  desc: z.coerce.boolean().catch(false),
});

export const jobDetailSearchSchema = z.object({
  run: z.string().optional().catch(undefined),
});

export const modelSearchSchema = z.object({
  family: z.enum(['all', 'Anthropic', 'OpenAI', 'OpenRouter']).catch('all'),
});

export const activitySearchSchema = z.object({
  q: z.string().catch(''),
  type: z
    .enum(['all', 'agent', 'job', 'permission', 'provider', 'settings'])
    .catch('all'),
  outcome: z.enum(['all', 'success', 'attention', 'failed']).catch('all'),
  page: z.coerce.number().int().min(1).catch(1),
  selected: z.string().optional().catch(undefined),
});
