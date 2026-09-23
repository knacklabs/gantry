import { z } from 'zod';

export const peopleSearchSchema = z.object({
  q: z.string().catch(''),
  provider: z.string().catch('all'),
  status: z.enum(['all', 'active', 'disabled', 'archived']).catch('all'),
  page: z.coerce.number().int().min(1).catch(1),
  sort: z.enum(['displayName', 'status', 'updatedAt']).catch('displayName'),
  desc: z.coerce.boolean().catch(false),
});
