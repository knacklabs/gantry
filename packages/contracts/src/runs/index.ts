import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const AgentRunCauseSchema = z.enum([
  'message',
  'job',
  'control',
  'manual',
  'system',
]);
export type AgentRunCause = z.infer<typeof AgentRunCauseSchema>;

export const AgentRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
  'timeout',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  configVersionId: z.string(),
  sessionId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  jobId: z.string().nullable().optional(),
  llmProfileId: z.string(),
  permissionDecisionIds: z.array(z.string()),
  // Deliberately absent: acceptance criterion 7 of the E2E reliability plan
  // says run responses expose no provider, worker, lease, or execution-provider
  // internals. The sandbox lease stays on the internal run record and its
  // storage row; z.object strips it here, so the public payload cannot carry it.
  workspaceSnapshotId: z.string().nullable().optional(),
  cause: AgentRunCauseSchema,
  status: AgentRunStatusSchema,
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable().optional(),
  endedAt: IsoDateTimeSchema.nullable().optional(),
  resultSummary: z.string().nullable().optional(),
  errorSummary: z.string().nullable().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;

export const AgentRunEventResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  runId: z.string(),
  type: z.string(),
  payload: z.unknown(),
  createdAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type AgentRunEventResponse = z.infer<typeof AgentRunEventResponseSchema>;

export const ActivityRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  cause: AgentRunCauseSchema,
  status: AgentRunStatusSchema,
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  resultSummary: z.string().nullable(),
  errorSummary: z.string().nullable(),
});
export type ActivityRun = z.infer<typeof ActivityRunSchema>;

export const ActivityTaskKindSchema = z.enum([
  'async_command',
  'delegated_agent',
  'mcp_tool_call',
  'session_compaction',
]);
export const ActivityTaskStatusSchema = z.enum([
  'queued',
  'running',
  'needs_attention',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export type ActivityTask = {
  id: string;
  agentId: string;
  targetAgentId: string | null;
  kind: z.infer<typeof ActivityTaskKindSchema>;
  status: z.infer<typeof ActivityTaskStatusSchema>;
  summary: string | null;
  outputSummary: string | null;
  errorSummary: string | null;
  currentPhase: string | null;
  lastProgress: string | null;
  lastToolSummary: string | null;
  blocker: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  terminalAt: string | null;
  durationMs: number | null;
  children: ActivityTask[];
};

export const ActivityTaskSchema: z.ZodType<ActivityTask> = z.object({
  id: z.string(),
  agentId: z.string(),
  targetAgentId: z.string().nullable(),
  kind: ActivityTaskKindSchema,
  status: ActivityTaskStatusSchema,
  summary: z.string().nullable(),
  outputSummary: z.string().nullable(),
  errorSummary: z.string().nullable(),
  currentPhase: z.string().nullable(),
  lastProgress: z.string().nullable(),
  lastToolSummary: z.string().nullable(),
  blocker: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  terminalAt: IsoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  children: z.lazy(() => z.array(ActivityTaskSchema)),
});

export const ActivityListResponseSchema = z.object({
  runs: z.array(ActivityRunSchema).max(50),
});
export type ActivityListResponse = z.infer<typeof ActivityListResponseSchema>;

export const ActivityDetailResponseSchema = z.object({
  run: ActivityRunSchema,
  tasks: z.array(ActivityTaskSchema),
  taskTotal: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ActivityDetailResponse = z.infer<
  typeof ActivityDetailResponseSchema
>;

export const ActivityInvalidationSchema = z.object({
  eventId: z.number().int().nonnegative(),
  type: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type ActivityInvalidation = z.infer<typeof ActivityInvalidationSchema>;

export const ActivityInvalidationListResponseSchema = z.object({
  events: z.array(ActivityInvalidationSchema).max(100),
});
export type ActivityInvalidationListResponse = z.infer<
  typeof ActivityInvalidationListResponseSchema
>;
