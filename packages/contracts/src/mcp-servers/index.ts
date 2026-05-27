import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const McpServerTransportSchema = z.enum([
  'http',
  'sse',
  'stdio_template',
]);
export const McpServerStatusSchema = z.enum([
  'draft',
  'approved',
  'rejected',
  'disabled',
]);
export const McpServerRiskClassSchema = z.enum(['low', 'medium', 'high']);

export const McpCredentialRefSchema = z.object({
  name: z.string().min(1),
  target: z.enum(['env', 'header']),
  key: z.string().min(1),
});

export const McpServerTransportConfigSchema = z.object({
  transport: McpServerTransportSchema,
  url: z.string().url().optional(),
  templateId: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  callerIdentity: z
    .object({
      mode: z.enum(['disabled', 'required']),
      headerName: z.string().min(1),
      signingRef: z.string().min(1),
      source: z.object({
        kind: z.literal('conversation_jid_phone'),
        jidPrefix: z.string().min(1),
      }),
    })
    .optional(),
});

export const McpServerDefinitionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  status: McpServerStatusSchema,
  createdSource: z.enum(['admin', 'agent_request']),
  riskClass: McpServerRiskClassSchema,
  requestedBy: z.string().optional(),
  requestedReason: z.string().optional(),
  latestApprovedVersionId: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  approvedBy: z.string().optional(),
  approvedAt: IsoDateTimeSchema.optional(),
  rejectedBy: z.string().optional(),
  rejectedAt: IsoDateTimeSchema.optional(),
  disabledBy: z.string().optional(),
  disabledAt: IsoDateTimeSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type McpServerDefinitionResponse = z.infer<
  typeof McpServerDefinitionResponseSchema
>;

export const McpServerVersionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  serverId: z.string(),
  version: z.number().int().positive(),
  transport: McpServerTransportSchema,
  config: McpServerTransportConfigSchema,
  allowedToolPatterns: z.array(z.string()),
  autoApproveToolPatterns: z.array(z.string()),
  credentialRefs: z.array(McpCredentialRefSchema),
  sandboxProfileId: z.string().optional(),
  configHash: z.string(),
  reviewedBy: z.string().optional(),
  reviewedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type McpServerVersionResponse = z.infer<
  typeof McpServerVersionResponseSchema
>;

export const AgentMcpServerBindingResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  serverId: z.string(),
  versionId: z.string(),
  status: z.enum(['active', 'disabled']),
  required: z.boolean(),
  permissionPolicyIds: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AgentMcpServerBindingResponse = z.infer<
  typeof AgentMcpServerBindingResponseSchema
>;

export const CreateMcpServerDraftRequestSchema = z.object({
  appId: z.string().optional(),
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  transport: McpServerTransportSchema,
  config: McpServerTransportConfigSchema,
  allowedToolPatterns: z.array(z.string()).default([]),
  autoApproveToolPatterns: z.array(z.string()).default([]),
  credentialRefs: z.array(McpCredentialRefSchema).default([]),
  sandboxProfileId: z.string().optional(),
  riskClass: McpServerRiskClassSchema.default('medium'),
  createdBy: z.string().optional(),
  requestedReason: z.string().optional(),
});
export type CreateMcpServerDraftRequest = z.infer<
  typeof CreateMcpServerDraftRequestSchema
>;

export const ApproveMcpServerDraftRequestSchema = z.object({
  appId: z.string().optional(),
  approvedBy: z.string().optional(),
});
export type ApproveMcpServerDraftRequest = z.infer<
  typeof ApproveMcpServerDraftRequestSchema
>;

export const RejectMcpServerDraftRequestSchema = z.object({
  appId: z.string().optional(),
  rejectedBy: z.string().optional(),
  reason: z.string().optional(),
});
export type RejectMcpServerDraftRequest = z.infer<
  typeof RejectMcpServerDraftRequestSchema
>;

export const DisableMcpServerRequestSchema = z.object({
  appId: z.string().optional(),
  disabledBy: z.string().optional(),
  reason: z.string().optional(),
});
export type DisableMcpServerRequest = z.infer<
  typeof DisableMcpServerRequestSchema
>;

export const UpdateAgentMcpServerBindingRequestSchema = z.object({
  appId: z.string().optional(),
  versionId: z.string().optional(),
  required: z.boolean().optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
});
export type UpdateAgentMcpServerBindingRequest = z.infer<
  typeof UpdateAgentMcpServerBindingRequestSchema
>;
