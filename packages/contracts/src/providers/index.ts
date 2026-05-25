import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { MemorySubjectRefSchema } from '../memory/index.js';

export const ProviderConnectionStatusSchema = z.enum([
  'active',
  'inactive',
  'disabled',
  'archived',
]);
export type ProviderConnectionStatus = z.infer<
  typeof ProviderConnectionStatusSchema
>;

export const ProviderResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: z.array(z.string()),
  status: z.enum(['available', 'unavailable', 'disabled']),
  placeholder: z.boolean().optional(),
  createdAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderResponseSchema),
});
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;

export const ProviderConnectionConfigSchema = ContractMetadataSchema;

export const CreateProviderConnectionRequestSchema = z.object({
  appId: z.string(),
  providerId: z.string(),
  label: z.string().min(1),
  config: ProviderConnectionConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.optional(),
  runtimeSecretRefs: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type CreateProviderConnectionRequest = z.infer<
  typeof CreateProviderConnectionRequestSchema
>;

export const ProviderConnectionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  providerId: z.string(),
  label: z.string(),
  status: ProviderConnectionStatusSchema,
  config: ProviderConnectionConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.optional(),
  runtimeSecretRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ProviderConnectionResponse = z.infer<
  typeof ProviderConnectionResponseSchema
>;

export const ProviderConnectionListResponseSchema = z.object({
  providerConnections: z.array(ProviderConnectionResponseSchema),
});
export type ProviderConnectionListResponse = z.infer<
  typeof ProviderConnectionListResponseSchema
>;

export const UpdateProviderConnectionRequestSchema = z.object({
  label: z.string().min(1).optional(),
  status: ProviderConnectionStatusSchema.optional(),
  config: ProviderConnectionConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.nullable().optional(),
  runtimeSecretRefs: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type UpdateProviderConnectionRequest = z.infer<
  typeof UpdateProviderConnectionRequestSchema
>;

export const DiscoverProviderConnectionRequestSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  includeArchived: z.boolean().optional(),
  providerMetadata: ContractMetadataSchema.optional(),
});
export type DiscoverProviderConnectionRequest = z.infer<
  typeof DiscoverProviderConnectionRequestSchema
>;

export const TriggerModeSchema = z.enum([
  'always',
  'mention',
  'keyword',
  'manual',
  'webhook',
]);
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

export const BindingMemoryScopeSchema = z.enum([
  'user',
  'conversation',
  'agent',
  'app',
]);
export type BindingMemoryScope = z.infer<typeof BindingMemoryScopeSchema>;

export const AgentConversationBindingStatusSchema = z.enum([
  'active',
  'disabled',
]);
export type AgentConversationBindingStatus = z.infer<
  typeof AgentConversationBindingStatusSchema
>;

export const AgentConversationBindingRequestSchema = z.object({
  appId: z.string().optional(),
  agentId: z.string().optional(),
  providerConnectionId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  displayName: z.string().optional(),
  triggerMode: TriggerModeSchema.optional(),
  triggerPattern: z.string().nullable().optional(),
  requiresTrigger: z.boolean().optional(),
  memoryScope: BindingMemoryScopeSchema.optional(),
  memorySubject: MemorySubjectRefSchema.optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  status: AgentConversationBindingStatusSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type AgentConversationBindingRequest = z.infer<
  typeof AgentConversationBindingRequestSchema
>;

export const AgentConversationBindingResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  providerConnectionId: z.string(),
  conversationId: z.string(),
  threadId: z.string().nullable().optional(),
  displayName: z.string(),
  status: AgentConversationBindingStatusSchema,
  triggerMode: TriggerModeSchema,
  triggerPattern: z.string().nullable().optional(),
  requiresTrigger: z.boolean(),
  memoryScope: BindingMemoryScopeSchema,
  memorySubject: MemorySubjectRefSchema.optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  permissionPolicyIds: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type AgentConversationBindingResponse = z.infer<
  typeof AgentConversationBindingResponseSchema
>;

export const AgentConversationBindingListResponseSchema = z.object({
  bindings: z.array(AgentConversationBindingResponseSchema),
});
export type AgentConversationBindingListResponse = z.infer<
  typeof AgentConversationBindingListResponseSchema
>;

export const ConversationApproverListResponseSchema = z.object({
  approvers: z.object({
    userIds: z.array(z.string().trim().min(1).max(128)).max(200),
  }),
});
export type ConversationApproverListResponse = z.infer<
  typeof ConversationApproverListResponseSchema
>;

export const ConversationApproverPutRequestSchema = z.object({
  userIds: z.array(z.string().trim().min(1).max(128)).max(200),
});
export type ConversationApproverPutRequest = z.infer<
  typeof ConversationApproverPutRequestSchema
>;
