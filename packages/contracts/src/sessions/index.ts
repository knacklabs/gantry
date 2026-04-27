import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const AgentSessionStatusSchema = z.enum([
  'active',
  'paused',
  'completed',
  'archived',
]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

export const ResponseModeSchema = z.enum(['sse', 'webhook', 'both', 'none']);
export type ResponseMode = z.infer<typeof ResponseModeSchema>;

export const CreateSessionRequestSchema = z.object({
  appId: z.string(),
  agentId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  jobId: z.string().optional(),
  userId: z.string().optional(),
  title: z.string().optional(),
  responseMode: ResponseModeSchema.optional(),
  webhookId: z.string().optional(),
  modelOverride: z.string().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ResumeSessionRequestSchema = z.object({
  appId: z.string().optional(),
  sessionId: z.string(),
  responseMode: ResponseModeSchema.optional(),
  webhookId: z.string().optional(),
  modelOverride: z.string().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

export const ProviderSessionResponseSchema = z.object({
  id: z.string(),
  provider: z.string().optional(),
  externalSessionId: z.string().optional(),
  artifactRef: z.string().optional(),
  sandboxId: z.string().nullable().optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  browserProfileId: z.string().nullable().optional(),
  providerRef: ExternalReferenceSchema,
  status: z.enum(['active', 'inactive', 'expired', 'revoked']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ProviderSessionResponse = z.infer<
  typeof ProviderSessionResponseSchema
>;

export const AgentSessionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  conversationId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  jobId: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  latestProviderSessionId: z.string().nullable().optional(),
  status: AgentSessionStatusSchema,
  modelOverride: z.string().nullable().optional(),
  providerSessions: z.array(ProviderSessionResponseSchema).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  resetAt: IsoDateTimeSchema.nullable().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type AgentSessionResponse = z.infer<typeof AgentSessionResponseSchema>;
