import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { AgentPersonaSchema } from '../agents/index.js';

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

export const JobModelSourceSchema = z.union([
  z.literal('explicit'),
  z.literal('system default'),
  z.literal('settings.yaml agent.default_model'),
  z.literal('settings.yaml agent.one_time_job_default_model'),
  z.literal('settings.yaml agent.recurring_job_default_model'),
  z.literal('group.agentConfig.model'),
]);
export type JobModelSource = z.infer<typeof JobModelSourceSchema>;

export const JobModelPreviewSchema = z.object({
  displayName: z.string(),
  provider: z.string(),
  contextWindowTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  cachePolicy: z.string(),
  modelProfileId: z.string(),
});
export type JobModelPreview = z.infer<typeof JobModelPreviewSchema>;

export const JobRuntimeContextPreviewSchema = z.object({
  sessionId: z.string(),
  conversationJid: z.string(),
  groupScope: z.string(),
  threadId: z.string().nullable(),
  notificationTarget: z.enum(['conversation', 'conversation_thread']),
  browserProfileLabel: z.string(),
  browserProfileName: z.string(),
  persona: AgentPersonaSchema,
});
export type JobRuntimeContextPreview = z.infer<
  typeof JobRuntimeContextPreviewSchema
>;

export const JobTargetSchema = z.object({
  sessionId: z.string().optional(),
  bindingId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  userId: z.string().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type JobTarget = z.infer<typeof JobTargetSchema>;

export const JobResolvedTargetSchema = z.object({
  appId: z.string(),
  agentId: z.string(),
  groupScope: z.string(),
  conversationJids: z.array(z.string()),
  threadId: z.string().nullable(),
});

export const JobRecentRunErrorSchema = z.object({
  runId: z.string(),
  status: z.string(),
  errorSummary: z.string(),
  endedAt: IsoDateTimeSchema.nullable(),
});

export const JobStalenessSchema = z.enum(['missed_window']);

export const CreateJobRequestSchema = z
  .object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    sessionId: z.string().min(1),
    kind: z.enum(['manual', 'once', 'recurring']).optional(),
    runAt: IsoDateTimeSchema.optional(),
    schedule: z
      .object({
        type: z.enum(['cron', 'interval']).optional(),
        value: z.string().optional(),
      })
      .optional(),
    executionMode: JobExecutionModeSchema.optional(),
    threadId: z.string().optional(),
    modelAlias: z.string().optional(),
    modelProfileId: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.modelAlias && value.modelProfileId), {
    message: 'Use either modelAlias or modelProfileId, not both.',
    path: ['modelProfileId'],
  });
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const UpdateJobRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    executionMode: JobExecutionModeSchema.optional(),
    threadId: z.string().nullable().optional(),
    status: z.enum(['active', 'paused']).optional(),
    modelAlias: z.string().nullable().optional(),
    modelProfileId: z.string().nullable().optional(),
    allowedTools: z.array(z.string()).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.modelAlias === undefined || value.modelProfileId === undefined,
    {
      message: 'Use either modelAlias or modelProfileId, not both.',
      path: ['modelProfileId'],
    },
  );
export type UpdateJobRequest = z.infer<typeof UpdateJobRequestSchema>;

export const JobResponseSchema = z.object({
  jobId: z.string(),
  name: z.string(),
  prompt: z.string().optional(),
  promptPreview: z.string().optional(),
  fullPrompt: z.string().optional(),
  kind: z.enum(['manual', 'once', 'recurring']),
  status: JobStatusSchema,
  schedule: z
    .union([
      z.null(),
      z.object({ type: z.literal('once'), runAt: IsoDateTimeSchema }),
      z.object({ type: z.enum(['cron', 'interval']), value: z.string() }),
    ])
    .nullable(),
  linkedSessions: z.array(z.string()),
  nextRun: IsoDateTimeSchema.nullable(),
  lastRun: IsoDateTimeSchema.nullable(),
  staleness: JobStalenessSchema.nullable().optional(),
  executionMode: JobExecutionModeSchema,
  modelAlias: z.string().nullable().optional(),
  modelProfileId: z.string().nullable().optional(),
  model: JobModelPreviewSchema.nullable().optional(),
  threadId: z.string().nullable(),
  groupScope: z.string(),
  sessionId: z.string().nullable(),
  target: JobResolvedTargetSchema.optional(),
  inheritedTools: z.array(z.string()).optional(),
  jobExtraTools: z.array(z.string()).optional(),
  effectiveAllowedTools: z.array(z.string()).optional(),
  inheritedToolCount: z.number().int().nonnegative().optional(),
  jobExtraToolCount: z.number().int().nonnegative().optional(),
  effectiveAllowedToolCount: z.number().int().nonnegative().optional(),
  recentRunErrors: z.array(JobRecentRunErrorSchema).optional(),
  notificationTarget: z
    .object({
      linkedSessions: z.array(z.string()),
      threadId: z.string().nullable(),
      silent: z.boolean(),
    })
    .optional(),
});
export type JobResponse = z.infer<typeof JobResponseSchema>;

export const CreateJobResponseSchema = z.object({
  jobId: z.string().optional(),
  dryRun: z.boolean().optional(),
  modelAlias: z.string().nullable().optional(),
  modelSource: JobModelSourceSchema.optional(),
  model: JobModelPreviewSchema.nullable().optional(),
  runtimeContext: JobRuntimeContextPreviewSchema.optional(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

export const ModelRecordSchema = z.object({
  id: z.string(),
  modelProfileId: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  recommendedAlias: z.string(),
  provider: z.string(),
  contextWindowTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  cacheMode: z.string(),
  cacheTokenFields: z.array(z.string()),
  supportsThinking: z.boolean(),
  supportsTools: z.boolean(),
  experimental: z.boolean(),
});
export type ModelRecord = z.infer<typeof ModelRecordSchema>;

export const ListModelsResponseSchema = z.object({
  models: z.array(ModelRecordSchema),
});
export type ListModelsResponse = z.infer<typeof ListModelsResponseSchema>;
