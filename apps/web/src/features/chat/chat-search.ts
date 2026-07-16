import { z } from 'zod';

export const chatListSearchSchema = z.object({
  q: z.string().catch(''),
  status: z.enum(['all', 'active', 'waiting', 'completed']).catch('all'),
  agent: z
    .enum(['all', 'Support triage', 'Research assistant', 'Operations analyst'])
    .catch('all'),
});

export const chatDetailSearchSchema = z.object({
  inspector: z.enum(['thread', 'timeline', 'files']).catch('thread'),
});

export const memorySearchSchema = z.object({
  category: z
    .enum(['all', 'Preference', 'Identity', 'Project', 'Relationship'])
    .catch('all'),
  confidence: z.enum(['all', 'high', 'medium', 'low']).catch('all'),
});
