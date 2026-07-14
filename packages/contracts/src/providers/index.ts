import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { MemorySubjectRefSchema } from '../memory/index.js';

export const ProviderAccountStatusSchema = z.enum([
  'active',
  'inactive',
  'disabled',
  'archived',
]);
export type ProviderAccountStatus = z.infer<typeof ProviderAccountStatusSchema>;

export const ProviderResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: z.array(z.string()),
  runtimeSecretKeys: z.array(z.string()).optional(),
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

export const ProviderAccountConfigSchema = ContractMetadataSchema;

export const CreateProviderAccountRequestSchema = z.object({
  appId: z.string(),
  agentId: z.string(),
  providerId: z.string(),
  label: z.string().min(1),
  config: ProviderAccountConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.optional(),
  runtimeSecretRefs: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type CreateProviderAccountRequest = z.infer<
  typeof CreateProviderAccountRequestSchema
>;

export const ProviderAccountResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  providerId: z.string(),
  label: z.string(),
  status: ProviderAccountStatusSchema,
  config: ProviderAccountConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.optional(),
  runtimeSecretRefs: z.record(z.string(), z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ProviderAccountResponse = z.infer<
  typeof ProviderAccountResponseSchema
>;

export const ProviderAccountListResponseSchema = z.object({
  providerAccounts: z.array(ProviderAccountResponseSchema),
});
export type ProviderAccountListResponse = z.infer<
  typeof ProviderAccountListResponseSchema
>;

export const UpdateProviderAccountRequestSchema = z.object({
  label: z.string().min(1).optional(),
  status: ProviderAccountStatusSchema.optional(),
  config: ProviderAccountConfigSchema.optional(),
  externalRef: ExternalReferenceSchema.nullable().optional(),
  runtimeSecretRefs: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type UpdateProviderAccountRequest = z.infer<
  typeof UpdateProviderAccountRequestSchema
>;

export const DiscoverProviderAccountRequestSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  includeArchived: z.boolean().optional(),
  providerMetadata: ContractMetadataSchema.optional(),
});
export type DiscoverProviderAccountRequest = z.infer<
  typeof DiscoverProviderAccountRequestSchema
>;

export const ConversationInstallMemoryScopeSchema = z.enum([
  'user',
  'conversation',
  'agent',
  'app',
]);
export type ConversationInstallMemoryScope = z.infer<
  typeof ConversationInstallMemoryScopeSchema
>;

export const ConversationInstallStatusSchema = z.enum(['active', 'disabled']);
export type ConversationInstallStatus = z.infer<
  typeof ConversationInstallStatusSchema
>;

export const ConversationInstallRouteConfigSchema = z.object({
  trigger: z.string().optional(),
  requiresTrigger: z.boolean().optional(),
  agentConfig: ContractMetadataSchema.optional(),
});
export type ConversationInstallRouteConfig = z.infer<
  typeof ConversationInstallRouteConfigSchema
>;

export const ConversationInstallRequestSchema = z.object({
  appId: z.string().optional(),
  agentId: z.string().optional(),
  providerAccountId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  displayName: z.string().optional(),
  memoryScope: ConversationInstallMemoryScopeSchema.optional(),
  memorySubject: MemorySubjectRefSchema.optional(),
  routeConfig: ConversationInstallRouteConfigSchema.optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  status: ConversationInstallStatusSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type ConversationInstallRequest = z.infer<
  typeof ConversationInstallRequestSchema
>;

export const ConversationInstallResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  providerAccountId: z.string(),
  conversationId: z.string(),
  threadId: z.string().nullable().optional(),
  displayName: z.string(),
  status: ConversationInstallStatusSchema,
  memoryScope: ConversationInstallMemoryScopeSchema,
  memorySubject: MemorySubjectRefSchema.optional(),
  routeConfig: ConversationInstallRouteConfigSchema.optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  permissionPolicyIds: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ConversationInstallResponse = z.infer<
  typeof ConversationInstallResponseSchema
>;

export const ConversationInstallListResponseSchema = z.object({
  conversationInstalls: z.array(ConversationInstallResponseSchema),
});
export type ConversationInstallListResponse = z.infer<
  typeof ConversationInstallListResponseSchema
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
