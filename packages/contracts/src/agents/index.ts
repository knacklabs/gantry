import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
  LlmProfileRefSchema,
  RuntimeLimitSchema,
} from '../contract-primitives.js';

export const AgentStatusSchema = z.enum(['active', 'disabled']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentPersonaSchema = z.enum([
  'developer',
  'personal_assistant',
  'sales',
  'marketing',
  'operations',
  'research',
]);
export type AgentPersona = z.infer<typeof AgentPersonaSchema>;

export const CreateAgentRequestSchema = z.object({
  appId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  promptProfileRef: z.string().optional(),
  llmProfileId: z.string().optional(),
  toolIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  sandboxProfileId: z.string().optional(),
  workspaceSnapshotId: z.string().optional(),
  runtimeLimits: RuntimeLimitSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: AgentStatusSchema.optional(),
  promptProfileRef: z.string().optional(),
  llmProfileId: z.string().optional(),
  toolIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  sandboxProfileId: z.string().nullable().optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  runtimeLimits: RuntimeLimitSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: AgentStatusSchema,
  currentConfigVersionId: z.string().nullable().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const AgentConfigVersionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  version: z.number().int().positive(),
  promptProfileRef: z.string(),
  llmProfile: LlmProfileRefSchema.optional(),
  llmProfileId: z.string().optional(),
  toolIds: z.array(z.string()),
  skillIds: z.array(z.string()),
  permissionPolicyIds: z.array(z.string()),
  sandboxProfileId: z.string().nullable().optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  runtimeLimits: RuntimeLimitSchema.optional(),
  createdAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type AgentConfigVersionResponse = z.infer<
  typeof AgentConfigVersionResponseSchema
>;

export const AgentCapabilitiesRequestSchema = z.object({
  selectedToolIds: z.array(z.string()),
  selectedSkillIds: z.array(z.string()),
  selectedMcpServerIds: z.array(z.string()),
});
export type AgentCapabilitiesRequest = z.infer<
  typeof AgentCapabilitiesRequestSchema
>;

export const AgentCapabilitiesResponseSchema = z.object({
  agentId: z.string(),
  selectedToolIds: z.array(z.string()),
  selectedSkillIds: z.array(z.string()),
  selectedMcpServerIds: z.array(z.string()),
  updatedAt: IsoDateTimeSchema,
});
export type AgentCapabilitiesResponse = z.infer<
  typeof AgentCapabilitiesResponseSchema
>;

export const AgentDmAccessEntrySchema = z.object({
  provider: z.string().min(1),
  userIds: z.array(z.string().min(1)),
  adminUserId: z.string().min(1).optional(),
});
export type AgentDmAccessEntry = z.infer<typeof AgentDmAccessEntrySchema>;

export const AgentDmAccessRequestSchema = z.object({
  entries: z.array(AgentDmAccessEntrySchema),
});
export type AgentDmAccessRequest = z.infer<typeof AgentDmAccessRequestSchema>;

export const AgentDmAccessResponseSchema = z.object({
  agentId: z.string(),
  dmAccess: z.object({
    entries: z.array(AgentDmAccessEntrySchema),
  }),
  updatedAt: IsoDateTimeSchema,
});
export type AgentDmAccessResponse = z.infer<typeof AgentDmAccessResponseSchema>;

export const AgentAdminBoundConversationSchema = z.object({
  conversationId: z.string(),
  provider: z.string().min(1),
  kind: z.string().min(1),
  displayName: z.string().min(1).optional(),
  approverUserIds: z.array(z.string().min(1)),
});
export type AgentAdminBoundConversation = z.infer<
  typeof AgentAdminBoundConversationSchema
>;

export const AgentAdminResponseSchema = z.object({
  agent: AgentResponseSchema,
  dmAccess: AgentDmAccessResponseSchema.shape.dmAccess,
  boundConversations: z.array(AgentAdminBoundConversationSchema),
});
export type AgentAdminResponse = z.infer<typeof AgentAdminResponseSchema>;
