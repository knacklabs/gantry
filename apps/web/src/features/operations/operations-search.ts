import { z } from 'zod';

const page = z.coerce.number().int().min(1).catch(1);
const descending = z.coerce.boolean().catch(false);

export const providerSearchSchema = z.object({
  q: z.string().catch(''),
  status: z.enum(['all', 'ready', 'attention', 'offline']).catch('all'),
  selected: z.string().optional().catch(undefined),
  page,
  sort: z.enum(['name', 'kind', 'status']).catch('name'),
  desc: descending,
});

export const conversationSearchSchema = z.object({
  q: z.string().catch(''),
  status: z.enum(['all', 'active', 'quiet', 'blocked']).catch('all'),
  page,
  sort: z.enum(['name', 'provider', 'activity', 'status']).catch('activity'),
  desc: descending,
});

export const interactionSearchSchema = z.object({
  kind: z.enum(['all', 'approval', 'question']).catch('all'),
  selected: z.string().optional().catch(undefined),
});

export const diagnosticSearchSchema = z.object({
  status: z.enum(['all', 'passing', 'warning', 'failing']).catch('all'),
});
