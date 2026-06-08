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
  'generalist',
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

export const AgentCapabilitySelectionSchema = z
  .object({
    id: z.string().min(1),
    version: z.union([z.string().min(1), z.number()]).transform(String),
  })
  .strict();
export type AgentCapabilitySelection = z.infer<
  typeof AgentCapabilitySelectionSchema
>;

export const AgentSourceSelectionSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    id: z.string().min(1),
    version: z.union([z.string().min(1), z.number()]).transform(String),
  })
  .strict();
export type AgentSourceSelection = z.infer<typeof AgentSourceSelectionSchema>;

export const AgentToolSourceSelectionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['builtin', 'adapter', 'local_cli']),
    version: z
      .union([z.string().min(1), z.number()])
      .transform(String)
      .optional(),
  })
  .strict();
export type AgentToolSourceSelection = z.infer<
  typeof AgentToolSourceSelectionSchema
>;

export const AgentSourcesRequestSchema = z
  .object({
    sources: z
      .object({
        skills: z.array(AgentSourceSelectionSchema).default([]),
        mcpServers: z.array(AgentSourceSelectionSchema).default([]),
        tools: z.array(AgentToolSourceSelectionSchema).default([]),
      })
      .strict(),
  })
  .strict();
export type AgentSourcesRequest = z.infer<typeof AgentSourcesRequestSchema>;

export const AgentCapabilitiesRequestSchema = z
  .object({
    capabilities: z.array(AgentCapabilitySelectionSchema),
  })
  .strict();
export type AgentCapabilitiesRequest = z.infer<
  typeof AgentCapabilitiesRequestSchema
>;

export const AgentToolAccessSchema = z
  .object({
    configuredTools: z.array(z.string()),
    defaultTools: z.array(z.string()),
    availableButGatedTools: z.array(z.string()),
    requestableAdminTools: z.array(
      z.object({
        tool: z.string(),
        toolId: z.string(),
        requestPermission: z.string(),
      }),
    ),
    source: z.string(),
  })
  .strict();
export type AgentToolAccess = z.infer<typeof AgentToolAccessSchema>;

export const AgentCapabilitiesResponseSchema = z
  .object({
    agentId: z.string(),
    sources: AgentSourcesRequestSchema.shape.sources,
    capabilities: z.array(AgentCapabilitySelectionSchema),
    toolAccess: AgentToolAccessSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type AgentCapabilitiesResponse = z.infer<
  typeof AgentCapabilitiesResponseSchema
>;

export const AgentAdminBoundConversationSchema = z.object({
  conversationId: z.string(),
  provider: z.string().min(1),
  kind: z.string().min(1),
  displayName: z.string().min(1).optional(),
  senderPolicy: z
    .object({
      allow: z.union([z.literal('*'), z.array(z.string().min(1))]),
      mode: z.enum(['trigger', 'drop']),
    })
    .strict()
    .optional(),
  requiresTrigger: z.boolean().optional(),
  approverUserIds: z.array(z.string().min(1)),
});
export type AgentAdminBoundConversation = z.infer<
  typeof AgentAdminBoundConversationSchema
>;

export const AgentAdminResponseSchema = z.object({
  agent: AgentResponseSchema,
  capabilities: AgentCapabilitiesResponseSchema.pick({
    sources: true,
    capabilities: true,
    toolAccess: true,
  }).optional(),
  boundConversations: z.array(AgentAdminBoundConversationSchema),
});
export type AgentAdminResponse = z.infer<typeof AgentAdminResponseSchema>;
