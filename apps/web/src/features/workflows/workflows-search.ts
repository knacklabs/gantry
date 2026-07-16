import { z } from 'zod';

export const workflowSearchSchema = z.object({
  q: z.string().catch(''),
  status: z.enum(['all', 'enabled', 'disabled', 'draft']).catch('all'),
});

export const newWorkflowSearchSchema = z.object({
  template: z.enum(['blank', 'approval', 'external']).catch('blank'),
});

export const workflowEditorSearchSchema = z.object({
  view: z.enum(['builder', 'review', 'versions']).catch('builder'),
});
