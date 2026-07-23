import { z } from 'zod';

import {
  AgentHarnessSchema,
  ContractMetadataSchema,
  IsoDateTimeSchema,
  LlmProfileRefSchema,
  RuntimeLimitSchema,
} from '../contract-primitives.js';

export * from './setup.js';

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

export const AgentRelationshipModeSchema = z.enum(['personal', 'organization']);
export type AgentRelationshipMode = z.infer<typeof AgentRelationshipModeSchema>;

export const AgentProfileFileKindSchema = z.enum(['soul', 'agents']);
export type AgentProfileFileKind = z.infer<typeof AgentProfileFileKindSchema>;

export const AgentProfileFileSummarySchema = z
  .object({
    kind: AgentProfileFileKindSchema,
    path: z.string(),
    version: z.number().int().nonnegative(),
    contentHash: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type AgentProfileFileSummary = z.infer<
  typeof AgentProfileFileSummarySchema
>;

export const AgentProfileFilesResponseSchema = z
  .object({
    agentId: z.string(),
    files: z.array(AgentProfileFileSummarySchema),
  })
  .strict();
export type AgentProfileFilesResponse = z.infer<
  typeof AgentProfileFilesResponseSchema
>;

export const AgentProfileFileContentResponseSchema = z
  .object({
    agentId: z.string(),
    kind: AgentProfileFileKindSchema,
    path: z.string(),
    version: z.number().int().nonnegative(),
    contentHash: z.string(),
    content: z.string(),
  })
  .strict();
export type AgentProfileFileContentResponse = z.infer<
  typeof AgentProfileFileContentResponseSchema
>;

// Coarse upper bound on profile content (chars ~ bytes for markdown). The
// runtime enforces the exact byte limit; this keeps oversized request bodies
// from reaching the service at all.
export const MAX_AGENT_PROFILE_CONTENT_BYTES = 2_000_000;

export const PutAgentProfileFileRequestSchema = z
  .object({
    content: z.string().max(MAX_AGENT_PROFILE_CONTENT_BYTES),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PutAgentProfileFileRequest = z.infer<
  typeof PutAgentProfileFileRequestSchema
>;

export const CreateAgentRequestSchema = z
  .object({
    appId: z.string(),
    name: z.string().min(1),
    agentHarness: AgentHarnessSchema.optional(),
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    status: AgentStatusSchema.optional(),
    agentHarness: AgentHarnessSchema.optional(),
  })
  .strict();
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const SetAgentModelRequestSchema = z
  .object({
    modelAlias: z.string().trim().min(1),
  })
  .strict();
export type SetAgentModelRequest = z.infer<typeof SetAgentModelRequestSchema>;

export const ReplaceAgentDelegatesRequestSchema = z
  .object({
    delegates: z.array(z.string().trim().min(1).max(160)).max(100),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ReplaceAgentDelegatesRequest = z.infer<
  typeof ReplaceAgentDelegatesRequestSchema
>;

export const AgentDelegateResolvedSchema = z
  .object({
    ref: z.string(),
    agentId: z.string(),
    toolName: z.string(),
    displayName: z.string(),
    persona: AgentPersonaSchema,
  })
  .strict();
export type AgentDelegateResolved = z.infer<typeof AgentDelegateResolvedSchema>;

export const AgentDelegatesResponseSchema = z
  .object({
    agentId: z.string(),
    revision: z.number().int().nonnegative(),
    delegates: z.array(z.string()),
    resolved: z.array(AgentDelegateResolvedSchema),
  })
  .strict();
export type AgentDelegatesResponse = z.infer<
  typeof AgentDelegatesResponseSchema
>;

export const AgentResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: AgentStatusSchema,
  agentHarness: AgentHarnessSchema,
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
    version: z
      .union([z.string().min(1), z.number()])
      .transform(String)
      .optional(),
  })
  .strict();
export type AgentSourceSelection = z.infer<typeof AgentSourceSelectionSchema>;

export const AgentMcpSourceSelectionSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    id: z.string().min(1),
    version: z
      .union([z.string().min(1), z.number()])
      .transform(String)
      .optional(),
    tools: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type AgentMcpSourceSelection = z.infer<
  typeof AgentMcpSourceSelectionSchema
>;

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
        mcpServers: z.array(AgentMcpSourceSelectionSchema).default([]),
        tools: z.array(AgentToolSourceSelectionSchema).default([]),
      })
      .strict(),
  })
  .strict();
export type AgentSourcesRequest = z.infer<typeof AgentSourcesRequestSchema>;

export const AgentAccessRequestSchema = z
  .object({
    sources: AgentSourcesRequestSchema.shape.sources,
    selections: z.array(AgentCapabilitySelectionSchema).default([]),
  })
  .strict();
export type AgentAccessRequest = z.infer<typeof AgentAccessRequestSchema>;

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

const AgentAccessSummaryEntrySchema = z
  .object({
    label: z.string(),
    detail: z.string(),
  })
  .strict();

export const AgentAccessSummarySchema = z
  .object({
    connected: z.array(AgentAccessSummaryEntrySchema),
    allowed: z.array(AgentAccessSummaryEntrySchema),
    needsAttention: z.array(AgentAccessSummaryEntrySchema),
    suggestedCleanup: z.array(AgentAccessSummaryEntrySchema),
  })
  .strict();
export type AgentAccessSummary = z.infer<typeof AgentAccessSummarySchema>;

export const AgentAccessResponseSchema = z
  .object({
    agentId: z.string(),
    sources: AgentSourcesRequestSchema.shape.sources,
    selections: z.array(AgentCapabilitySelectionSchema),
    toolAccess: AgentToolAccessSchema,
    summary: AgentAccessSummarySchema.optional(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type AgentAccessResponse = z.infer<typeof AgentAccessResponseSchema>;

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
