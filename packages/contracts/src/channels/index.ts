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
  createdAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ChannelProviderResponse = z.infer<
  typeof ChannelProviderResponseSchema
>;

export const CreateChannelInstallationRequestSchema = z.object({
  appId: z.string(),
  providerId: z.string(),
  label: z.string().min(1),
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
  externalRef: ExternalReferenceSchema.optional(),
  runtimeSecretRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ChannelInstallationResponse = z.infer<
  typeof ChannelInstallationResponseSchema
>;

export const AgentChannelBindingRequestSchema = z.object({
  appId: z.string(),
  agentId: z.string(),
  channelInstallationId: z.string(),
  conversationId: z.string(),
  threadId: z.string().optional(),
  displayName: z.string().optional(),
  triggerPattern: z.string().nullable().optional(),
  requiresTrigger: z.boolean().optional(),
  isAdminBinding: z.boolean().optional(),
  memorySubject: MemorySubjectRefSchema.optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
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
  triggerPattern: z.string().nullable().optional(),
  requiresTrigger: z.boolean(),
  isAdminBinding: z.boolean(),
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
