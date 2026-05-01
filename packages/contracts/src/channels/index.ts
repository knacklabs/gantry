import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { MemorySubjectRefSchema } from '../memory/index.js';

export const ChannelInstallationStatusSchema = z.enum([
  'active',
  'inactive',
  'disabled',
  'archived',
]);
export type ChannelInstallationStatus = z.infer<
  typeof ChannelInstallationStatusSchema
>;

export const ChannelProviderResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: z.array(z.string()),
  status: z.enum(['available', 'unavailable', 'disabled']),
  placeholder: z.boolean().optional(),
  createdAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ChannelProviderResponse = z.infer<
  typeof ChannelProviderResponseSchema
>;

export const ChannelProviderListResponseSchema = z.object({
  providers: z.array(ChannelProviderResponseSchema),
});
export type ChannelProviderListResponse = z.infer<
  typeof ChannelProviderListResponseSchema
>;

export const ChannelInstallationConfigSchema = ContractMetadataSchema;

export const CreateChannelInstallationRequestSchema = z.object({
  appId: z.string(),
  providerId: z.string(),
  label: z.string().min(1),
  config: ChannelInstallationConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.optional(),
  runtimeSecretRefs: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type CreateChannelInstallationRequest = z.infer<
  typeof CreateChannelInstallationRequestSchema
>;

export const ChannelInstallationResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  providerId: z.string(),
  label: z.string(),
  status: ChannelInstallationStatusSchema,
  config: ChannelInstallationConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.optional(),
  runtimeSecretRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ChannelInstallationResponse = z.infer<
  typeof ChannelInstallationResponseSchema
>;

export const ChannelInstallationListResponseSchema = z.object({
  installations: z.array(ChannelInstallationResponseSchema),
});
export type ChannelInstallationListResponse = z.infer<
  typeof ChannelInstallationListResponseSchema
>;

export const UpdateChannelInstallationRequestSchema = z.object({
  label: z.string().min(1).optional(),
  status: ChannelInstallationStatusSchema.optional(),
  config: ChannelInstallationConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.nullable().optional(),
  runtimeSecretRefs: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type UpdateChannelInstallationRequest = z.infer<
  typeof UpdateChannelInstallationRequestSchema
>;

export const DiscoverChannelInstallationRequestSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  includeArchived: z.boolean().optional(),
  providerMetadata: ContractMetadataSchema.optional(),
});
export type DiscoverChannelInstallationRequest = z.infer<
  typeof DiscoverChannelInstallationRequestSchema
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
  'thread',
  'agent',
  'app',
]);
export type BindingMemoryScope = z.infer<typeof BindingMemoryScopeSchema>;

export const AgentChannelBindingStatusSchema = z.enum(['active', 'disabled']);
export type AgentChannelBindingStatus = z.infer<
  typeof AgentChannelBindingStatusSchema
>;

export const AgentChannelBindingRequestSchema = z.object({
  appId: z.string().optional(),
  agentId: z.string().optional(),
  channelInstallationId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  displayName: z.string().optional(),
  triggerMode: TriggerModeSchema.optional(),
  triggerPattern: z.string().nullable().optional(),
  requiresTrigger: z.boolean().optional(),
  isAdminBinding: z.boolean().optional(),
  memoryScope: BindingMemoryScopeSchema.optional(),
  memorySubject: MemorySubjectRefSchema.optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  status: AgentChannelBindingStatusSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type AgentChannelBindingRequest = z.infer<
  typeof AgentChannelBindingRequestSchema
>;

export const AgentChannelBindingResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  channelInstallationId: z.string(),
  conversationId: z.string(),
  threadId: z.string().nullable().optional(),
  displayName: z.string(),
  status: AgentChannelBindingStatusSchema,
  triggerMode: TriggerModeSchema,
  triggerPattern: z.string().nullable().optional(),
  requiresTrigger: z.boolean(),
  isAdminBinding: z.boolean(),
  memoryScope: BindingMemoryScopeSchema,
  memorySubject: MemorySubjectRefSchema.optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  permissionPolicyIds: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type AgentChannelBindingResponse = z.infer<
  typeof AgentChannelBindingResponseSchema
>;

export const AgentChannelBindingListResponseSchema = z.object({
  bindings: z.array(AgentChannelBindingResponseSchema),
});
export type AgentChannelBindingListResponse = z.infer<
  typeof AgentChannelBindingListResponseSchema
>;

export const ChannelUserAllowlistSchema = z.object({
  userIds: z.array(z.string().trim().min(1).max(128)).max(200),
});
export type ChannelUserAllowlist = z.infer<typeof ChannelUserAllowlistSchema>;

export const ChannelConversationKindSchema = z.enum([
  'channel',
  'group',
  'dm',
  'service',
  'web',
  'sdk',
]);
export const ChannelConversationStatusSchema = z.enum([
  'active',
  'archived',
  'inactive',
]);

export const ChannelConversationResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  channelInstallationId: z.string(),
  externalRef: ExternalReferenceSchema.optional(),
  kind: ChannelConversationKindSchema,
  title: z.string().nullable(),
  status: ChannelConversationStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ChannelConversationResponse = z.infer<
  typeof ChannelConversationResponseSchema
>;

export const ChannelSessionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  conversationId: z.string(),
  externalRef: ExternalReferenceSchema.optional(),
  title: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ChannelSessionResponse = z.infer<
  typeof ChannelSessionResponseSchema
>;

export const ChannelAdminResponseSchema = z.object({
  channel: ChannelConversationResponseSchema,
  agents: z.array(AgentChannelBindingResponseSchema),
  sessions: z.array(ChannelSessionResponseSchema),
  controlAllowlist: ChannelUserAllowlistSchema,
});
export type ChannelAdminResponse = z.infer<typeof ChannelAdminResponseSchema>;

export const UpdateChannelControlAllowlistRequestSchema = z.object({
  userIds: ChannelUserAllowlistSchema.shape.userIds,
});
export type UpdateChannelControlAllowlistRequest = z.infer<
  typeof UpdateChannelControlAllowlistRequestSchema
>;

export const UpdateChannelControlAllowlistResponseSchema = z.object({
  controlAllowlist: ChannelUserAllowlistSchema,
});
export type UpdateChannelControlAllowlistResponse = z.infer<
  typeof UpdateChannelControlAllowlistResponseSchema
>;

export const CreateChannelRequestSchema = z
  .object({
    channelInstallationId: z.string().trim().min(1),
    externalId: z.string().trim().min(1).max(512),
    title: z.string().trim().min(1).max(512).optional(),
    label: z.string().trim().min(1).max(512).optional(),
    kind: z.enum(['direct', 'group', 'channel', 'service', 'web']).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.title || value.label), {
    message: 'title or label is required',
    path: ['title'],
  });
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const UpdateChannelRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(512).optional(),
    status: z.enum(['active', 'archived', 'disabled']).optional(),
  })
  .strict();
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

export const BindChannelAgentsRequestSchema = z
  .object({
    agentIds: z.array(z.string().trim().min(1)).min(1).max(100),
    defaultAgentId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.defaultAgentId || value.agentIds.includes(value.defaultAgentId),
    {
      message: 'defaultAgentId must be included in agentIds',
      path: ['defaultAgentId'],
    },
  );
export type BindChannelAgentsRequest = z.infer<
  typeof BindChannelAgentsRequestSchema
>;

export const CreateChannelSessionRequestSchema = z
  .object({
    externalThreadId: z.string().trim().min(1).max(512).optional(),
    title: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type CreateChannelSessionRequest = z.infer<
  typeof CreateChannelSessionRequestSchema
>;
