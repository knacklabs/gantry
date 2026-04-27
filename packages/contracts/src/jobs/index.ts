import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const JobScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('once'), runAt: IsoDateTimeSchema }),
  z.object({ type: z.literal('cron'), value: z.string().min(1) }),
  z.object({ type: z.literal('interval'), value: z.string().min(1) }),
]);
export type JobSchedule = z.infer<typeof JobScheduleSchema>;

export const JobStatusSchema = z.enum([
  'active',
  'paused',
  'running',
  'completed',
  'failed',
  'dead_lettered',
  'archived',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobExecutionModeSchema = z.enum(['parallel', 'serialized']);
export type JobExecutionMode = z.infer<typeof JobExecutionModeSchema>;

export const JobTargetSchema = z.object({
  sessionId: z.string().optional(),
  bindingId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  userId: z.string().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type JobTarget = z.infer<typeof JobTargetSchema>;

export const CreateJobRequestSchema = z.object({
  appId: z.string(),
  agentId: z.string().optional(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  schedule: JobScheduleSchema.optional(),
  target: JobTargetSchema.optional(),
  executionMode: JobExecutionModeSchema.optional(),
  modelOverride: z.string().optional(),
  silent: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  retryBackoffMs: z.number().int().nonnegative().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const JobResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  createdByActorId: z.string().optional(),
  createdBySource: z.string().optional(),
  name: z.string(),
  prompt: z.string(),
  schedule: JobScheduleSchema,
  status: JobStatusSchema,
  executionMode: JobExecutionModeSchema,
  target: JobTargetSchema,
  modelOverride: z.string().nullable().optional(),
  silent: z.boolean(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  retryBackoffMs: z.number().int().nonnegative(),
  nextRunAt: IsoDateTimeSchema.nullable().optional(),
  lastRunAt: IsoDateTimeSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type JobResponse = z.infer<typeof JobResponseSchema>;
