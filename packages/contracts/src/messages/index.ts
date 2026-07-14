import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { CursorPageRequestSchema } from '../pagination/index.js';

export const MessageDirectionSchema = z.enum([
  'inbound',
  'outbound',
  'system',
  'tool',
]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageDeliveryStatusSchema = z.enum([
  'pending',
  'sent',
  'failed',
  'partially_sent',
]);
export type MessageDeliveryStatus = z.infer<typeof MessageDeliveryStatusSchema>;

export const MessageTrustSchema = z.enum([
  'trusted',
  'untrusted',
  'system',
  'redacted',
]);
export type MessageTrust = z.infer<typeof MessageTrustSchema>;

export const MessagePartSchema = z.object({
  id: z.string().optional(),
  ordinal: z.number().int().min(0),
  kind: z.enum([
    'text',
    'markdown',
    'code',
    'image',
    'file',
    'tool_result',
    'form_response',
    'structured',
    'redacted',
  ]),
  payload: z.unknown(),
  metadata: ContractMetadataSchema.optional(),
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const MessageAttachmentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  contentType: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  externalRef: ExternalReferenceSchema.optional(),
  storageRef: z.string().nullable().optional(),
  trust: MessageTrustSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const ListMessagesRequestSchema = CursorPageRequestSchema.extend({
  appId: z.string(),
  conversationId: z.string(),
  threadId: z.string().optional(),
  direction: MessageDirectionSchema.optional(),
  since: IsoDateTimeSchema.optional(),
  until: IsoDateTimeSchema.optional(),
});
export type ListMessagesRequest = z.infer<typeof ListMessagesRequestSchema>;

export const MessageResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  providerId: z.string().optional(),
  providerAccountId: z.string().optional(),
  conversationId: z.string(),
  threadId: z.string().nullable().optional(),
  externalMessageId: z.string().nullable().optional(),
  externalRef: ExternalReferenceSchema.optional(),
  direction: MessageDirectionSchema,
  senderUserId: z.string().nullable().optional(),
  senderDisplayName: z.string().nullable().optional(),
  trust: MessageTrustSchema,
  deliveryStatus: MessageDeliveryStatusSchema.nullable().optional(),
  deliveredAt: IsoDateTimeSchema.nullable().optional(),
  deliveryError: z.string().nullable().optional(),
  parts: z.array(MessagePartSchema),
  attachments: z.array(MessageAttachmentSchema).optional(),
  createdAt: IsoDateTimeSchema,
  receivedAt: IsoDateTimeSchema.nullable().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

export const MessageListResponseSchema = z.object({
  messages: z.array(MessageResponseSchema),
});
export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;
