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
    agentName: z.string().optional(),
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
  .strict()
  .superRefine((value, ctx) => {
    // The runtime enforces this too; the contract states it so a bound
    // channel session fails at parse time, not deep in the module. A type-level
    // discriminated union was reviewed and rejected: it would reshape the
    // generated OpenAPI for marginal static safety the parse already enforces.
    if (value.appUser && value.conversationKind !== 'dm') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appUser'],
        message: "appUser requires conversationKind 'dm'",
      });
    }
  });
// z.input: the wire schema defaults conversationKind, so callers may omit it.
export type CreateSessionRequest = z.input<typeof CreateSessionRequestSchema>;

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

// Exactly three decisions by product decision: no timed grants.
export const SessionInteractionDecisionSchema = z.enum([
  'allow_once',
  'allow_future',
  'deny',
]);
export type SessionInteractionDecision = z.infer<
  typeof SessionInteractionDecisionSchema
>;

export const SessionPendingInteractionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['permission', 'question']),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    runId: z.string().nullable(),
    toolName: z.string().nullable(),
    summary: z.string().nullable(),
    questions: z.array(z.string()).nullable(),
    options: z.array(SessionInteractionDecisionSchema),
  })
  .strict();
export type SessionPendingInteraction = z.infer<
  typeof SessionPendingInteractionSchema
>;

export const SessionInteractionListResponseSchema = z
  .object({
    interactions: z.array(SessionPendingInteractionSchema),
  })
  .strict();
export type SessionInteractionListResponse = z.infer<
  typeof SessionInteractionListResponseSchema
>;

export const RespondSessionInteractionRequestSchema = z
  .object({
    decision: SessionInteractionDecisionSchema,
  })
  .strict();
export type RespondSessionInteractionRequest = z.infer<
  typeof RespondSessionInteractionRequestSchema
>;

export const RespondSessionInteractionResponseSchema = z
  .object({
    status: z.literal('resolved'),
    interactionId: z.string(),
    decision: SessionInteractionDecisionSchema,
    decidedBy: z.string(),
  })
  .strict();
export type RespondSessionInteractionResponse = z.infer<
  typeof RespondSessionInteractionResponseSchema
>;

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
