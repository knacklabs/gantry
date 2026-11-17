import { z } from 'zod';

const id = z.string().min(1).max(256);
const count = z.number().int().positive().safe();
const position = z.string().regex(/^[1-9][0-9]*$/);
const checkpoint = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const SourceBindingSchema = z
  .object({
    discussionId: id,
    generation: count,
    workspaceId: id,
    tenderId: id,
  })
  .strict();
export const SourceAuthoritySchema = z
  .object({
    authorityId: id,
    authorityVersion: id,
    kind: z.enum(['service', 'person']),
    subject: id,
    expiresAt: z.string().datetime(),
  })
  .strict();
export const SourceMessageSchema = z
  .object({
    sourceMessageId: id,
    sourcePosition: position,
    authorId: id,
    authorKind: z.enum(['human', 'system', 'assistant']),
    authorDisplayName: z.string().max(256),
    text: z.string().max(64000),
    createdAt: z.string().datetime(),
    replyToSourceId: id.nullable(),
    revisionId: id,
    origin: z.enum(['human', 'revision', 'runtime_output']),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeOutputId: id.optional(),
    answerGoalId: id.optional(),
  })
  .strict();
export const AppendSourceMessageRequestSchema = z
  .object({
    binding: SourceBindingSchema,
    authority: SourceAuthoritySchema,
    message: SourceMessageSchema,
    idempotencyKey: id,
  })
  .strict();
export const AppendSourceMessageResponseSchema = z
  .object({
    stored: z.literal(true),
    replayed: z.boolean(),
    messageId: id,
    sourceMessageId: id,
    sourcePosition: position,
    generation: count,
    persistedEventId: position,
    contiguousPosition: checkpoint,
  })
  .strict();
export const SourceAnswerExecutionProfileSchema = z
  .object({
    instructionsVersion: id,
    responseSchema: z.record(z.string(), z.unknown()),
    callerResolvedTools: z
      .array(
        z
          .object({
            name: id,
            description: z.string().min(1).max(1000),
            inputSchema: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(8),
    maxToolInteractions: count.max(16),
    interactionTimeoutMs: count.max(180000),
  })
  .strict();
export const RequestSourceAnswerSchema = z
  .object({
    binding: SourceBindingSchema,
    authority: SourceAuthoritySchema,
    questionSourceId: id,
    sourceCutoff: position,
    requesterId: id,
    answerGoalId: id,
    attemptId: id,
    idempotencyKey: id,
    revisionId: id,
    analysisReady: z.literal(true),
    executionProfile: SourceAnswerExecutionProfileSchema.optional(),
    model: id,
    maxOutputTokens: count.max(32000),
    deadlineAt: z.string().datetime(),
  })
  .strict();
export const RequestSourceAnswerResponseSchema = z
  .object({
    accepted: z.literal(true),
    replayed: z.boolean(),
    answerGoalId: id,
    attemptId: id,
    questionMessageId: id,
    acceptedEventId: position,
    state: z.enum([
      'preparing',
      'queued',
      'running',
      'completed',
      'failed',
      'canceled',
    ]),
  })
  .strict();
export const SourceHistoryRequestedSchema = z
  .object({
    interactionType: z.literal('source_history'),
    interactionId: id,
    binding: SourceBindingSchema,
    authority: SourceAuthoritySchema,
    sourceCutoff: position,
    afterPosition: checkpoint,
    missingSourceIds: z.array(id).max(100),
    pageLimit: count.max(100),
    byteLimit: count.max(1048576),
    sourceVersion: id,
    answerGoalId: id.optional(),
    attemptId: id.optional(),
  })
  .strict();
export const SettleSourceHistorySchema = z
  .object({
    interactionId: id,
    idempotencyKey: id,
    binding: SourceBindingSchema,
    sourceVersion: id,
    status: z.enum(['ok', 'unavailable', 'rejected', 'temporary_failure']),
    messages: z.array(SourceMessageSchema).max(100),
    returnedThrough: checkpoint,
    hasMore: z.boolean(),
    errorCode: id.optional(),
  })
  .strict();
export const ExecutionAuthorityRequestedSchema = z
  .object({
    interactionType: z.literal('execution_authority'),
    interactionId: id,
    binding: SourceBindingSchema,
    authority: SourceAuthoritySchema,
    answerGoalId: id,
    attemptId: id,
    phase: z.enum(['admission', 'execution', 'evidence', 'publication']),
  })
  .strict();
export const SettleExecutionAuthoritySchema = z
  .object({
    interactionId: id,
    idempotencyKey: id,
    binding: SourceBindingSchema,
    answerGoalId: id,
    attemptId: id,
    allowed: z.boolean(),
    authorityVersion: id,
    expiresAt: z.string().datetime(),
    reason: id.optional(),
  })
  .strict();
export type SourceBinding = z.infer<typeof SourceBindingSchema>;
export type SourceAuthority = z.infer<typeof SourceAuthoritySchema>;
export type SourceMessage = z.infer<typeof SourceMessageSchema>;
export type AppendSourceMessageRequest = z.infer<
  typeof AppendSourceMessageRequestSchema
>;
export type AppendSourceMessageResponse = z.infer<
  typeof AppendSourceMessageResponseSchema
>;
export type RequestSourceAnswer = z.infer<typeof RequestSourceAnswerSchema>;
export type RequestSourceAnswerResponse = z.infer<
  typeof RequestSourceAnswerResponseSchema
>;
export type SourceHistoryRequested = z.infer<
  typeof SourceHistoryRequestedSchema
>;
export type SettleSourceHistory = z.infer<typeof SettleSourceHistorySchema>;
export type ExecutionAuthorityRequested = z.infer<
  typeof ExecutionAuthorityRequestedSchema
>;
export type SettleExecutionAuthority = z.infer<
  typeof SettleExecutionAuthoritySchema
>;

export const RebuildSourceGenerationSchema = z
  .object({
    binding: SourceBindingSchema,
    nextGeneration: count,
    idempotencyKey: id,
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type RebuildSourceGeneration = z.infer<
  typeof RebuildSourceGenerationSchema
>;
export const RebuildSourceGenerationResponseSchema = z
  .object({
    binding: SourceBindingSchema,
    contiguousPosition: checkpoint,
    persistedEventId: position,
    replayed: z.boolean(),
  })
  .strict();
export type RebuildSourceGenerationResponse = z.infer<
  typeof RebuildSourceGenerationResponseSchema
>;
