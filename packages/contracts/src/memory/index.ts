import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const MemorySubjectTypeSchema = z.enum([
  'app',
  'agent',
  'user',
  'group',
  'channel',
  'conversation',
  'common',
]);
export type MemorySubjectType = z.infer<typeof MemorySubjectTypeSchema>;

export const MemoryKindSchema = z.enum([
  'preference',
  'decision',
  'fact',
  'correction',
  'constraint',
  'reference',
  'procedure',
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemorySubjectRefSchema = z.object({
  type: MemorySubjectTypeSchema,
  id: z.string(),
  displayName: z.string().optional(),
  externalRef: ExternalReferenceSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type MemorySubjectRef = z.infer<typeof MemorySubjectRefSchema>;

export const MemorySearchRequestSchema = z.object({
  appId: z.string().optional(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
  groupId: z.string().optional(),
  channelId: z.string().optional(),
  conversationId: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeCommon: z.boolean().optional(),
  subjectTypes: z.array(MemorySubjectTypeSchema).optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;

export * from './pattern-candidates.js';

export const MemoryItemResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string().nullable().optional(),
  subjectType: MemorySubjectTypeSchema.optional(),
  subjectId: z.string().optional(),
  userId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  subject: MemorySubjectRefSchema,
  kind: MemoryKindSchema,
  key: z.string(),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  source: ExternalReferenceSchema.optional(),
  status: z.enum(['active', 'archived', 'superseded']),
  lastObservedAt: IsoDateTimeSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type MemoryItemResponse = z.infer<typeof MemoryItemResponseSchema>;

export const MEMORY_IPC_ACTIONS = [
  'memory_search',
  'memory_save',
  'brain_search',
  'brain_query',
  'brain_write',
  'memory_patch',
  'memory_demote',
  'continuity_summary',
  'memory_consolidate',
  'memory_dream',
  'memory_review_pending',
  'memory_review_decision',
  'procedure_save',
  'procedure_patch',
] as const;

export const MemoryIpcActionSchema = z.enum(MEMORY_IPC_ACTIONS);
export type MemoryIpcAction = (typeof MEMORY_IPC_ACTIONS)[number];

export const MemoryIpcRequestSchema = z.object({
  requestId: z.string(),
  action: MemoryIpcActionSchema,
  payload: ContractMetadataSchema,
  context: z
    .object({
      appId: z.string().optional(),
      agentId: z.string().optional(),
      threadId: z.string().optional(),
      userId: z.string().optional(),
      defaultScope: z.enum(['user', 'group']).optional(),
    })
    .optional(),
});
export type MemoryIpcRequest = z.infer<typeof MemoryIpcRequestSchema>;

export const MemoryIpcResponseSchema = z.object({
  ok: z.boolean(),
  requestId: z.string(),
  provider: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type MemoryIpcResponse = z.infer<typeof MemoryIpcResponseSchema>;
