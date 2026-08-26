import { z } from 'zod';

export const agentListSearchSchema = z.object({
  tab: z.enum(['agents', 'roles']).catch('agents'),
  q: z.string().catch(''),
  status: z.enum(['all', 'active', 'disabled']).catch('all'),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((value) => [25, 50, 100].includes(value))
    .catch(25),
  role: z.string().catch('all'),
  sort: z.enum(['name', 'status', 'updatedAt']).catch('name'),
  desc: z.coerce.boolean().catch(false),
});

export const agentDetailSearchSchema = z.object({
  tab: z
    .enum(['overview', 'instructions', 'access', 'settings'])
    .catch('overview'),
});
