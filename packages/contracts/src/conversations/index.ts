import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { CursorPageRequestSchema } from '../pagination/index.js';

export const ConversationKindSchema = z.enum([
  'dm',
  'group',
  'channel',
  'chat',
  'web',
  'sdk',
]);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ConversationStatusSchema = z.enum([
  'active',
  'inactive',
  'archived',
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const DiscoverConversationsRequestSchema =
  CursorPageRequestSchema.extend({
    appId: z.string(),
    providerAccountId: z.string(),
    query: z.string().optional(),
    includeArchived: z.boolean().optional(),
    providerMetadata: ContractMetadataSchema.optional(),
  });
export type DiscoverConversationsRequest = z.infer<
  typeof DiscoverConversationsRequestSchema
>;

export const ConversationResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  providerAccountId: z.string(),
  externalRef: ExternalReferenceSchema.optional(),
  kind: ConversationKindSchema,
  title: z.string().nullable().optional(),
  status: ConversationStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const ConversationListResponseSchema = z.object({
  conversations: z.array(ConversationResponseSchema),
});
export type ConversationListResponse = z.infer<
  typeof ConversationListResponseSchema
>;

export const ConversationThreadResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  conversationId: z.string(),
  externalRef: ExternalReferenceSchema.optional(),
  title: z.string().nullable().optional(),
  status: ConversationStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ConversationThreadResponse = z.infer<
  typeof ConversationThreadResponseSchema
>;

export const ConversationThreadListResponseSchema = z.object({
  threads: z.array(ConversationThreadResponseSchema),
});
export type ConversationThreadListResponse = z.infer<
  typeof ConversationThreadListResponseSchema
>;
