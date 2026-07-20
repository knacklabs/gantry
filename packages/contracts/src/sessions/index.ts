import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const AgentSessionStatusSchema = z.enum(['active', 'reset', 'archived']);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

export const ResponseModeSchema = z.enum(['sse', 'webhook', 'both', 'none']);
export type ResponseMode = z.infer<typeof ResponseModeSchema>;

export const SessionConversationKindSchema = z.enum(['dm', 'channel']);
export type SessionConversationKind = z.infer<
  typeof SessionConversationKindSchema
>;

export const AppUserAssertionSchema = z
  .object({
    authorityId: z.string().min(1),
    subject: z.string().min(1),
  })
  .strict();
export type AppUserAssertion = z.infer<typeof AppUserAssertionSchema>;

export const CreateSessionRequestSchema = z
  .object({
    appId: z.string().optional(),
    agentId: z.string().optional(),
    conversationId: z.string().optional(),
    conversationKind: SessionConversationKindSchema.default('channel'),
    threadId: z.string().optional(),
    jobId: z.string().optional(),
    appUser: AppUserAssertionSchema.optional(),
    title: z.string().optional(),
    responseMode: ResponseModeSchema.optional(),
    webhookId: z.string().optional(),
    metadata: ContractMetadataSchema.optional(),
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ResumeSessionRequestSchema = z
  .object({
    appId: z.string().optional(),
    sessionId: z.string(),
    responseMode: ResponseModeSchema.optional(),
    webhookId: z.string().optional(),
    metadata: ContractMetadataSchema.optional(),
  })
  .strict();
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

export const ProviderSessionResponseSchema = z
  .object({
    provider: z.string().optional(),
    status: z.enum(['active', 'expired', 'reset']),
    hasProviderResume: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
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
  appUser: AppUserAssertionSchema.nullable().optional(),
  status: AgentSessionStatusSchema,
  providerSessions: z.array(ProviderSessionResponseSchema).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  resetAt: IsoDateTimeSchema.nullable().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type AgentSessionResponse = z.infer<typeof AgentSessionResponseSchema>;
