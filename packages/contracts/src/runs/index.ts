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
