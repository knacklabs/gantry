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
export const McpServerStatusSchema = z.enum(['active', 'disabled']);
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
  transport: McpServerTransportSchema,
  config: McpServerTransportConfigSchema,
  allowedToolPatterns: z.array(z.string()),
  autoApproveToolPatterns: z.array(z.string()),
  credentialRefs: z.array(McpCredentialRefSchema),
  networkHosts: z.array(z.string()).default([]),
  sandboxProfileId: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  disabledBy: z.string().optional(),
  disabledAt: IsoDateTimeSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type McpServerDefinitionResponse = z.infer<
  typeof McpServerDefinitionResponseSchema
>;

export const AgentMcpServerBindingResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  serverId: z.string(),
  status: z.enum(['active', 'disabled']),
  required: z.boolean(),
  permissionPolicyIds: z.array(z.string()),
  allowedToolPatterns: z.array(z.string()).default([]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AgentMcpServerBindingResponse = z.infer<
  typeof AgentMcpServerBindingResponseSchema
>;

export const ConnectMcpServerRequestSchema = z.object({
  appId: z.string().optional(),
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  transport: McpServerTransportSchema,
  config: McpServerTransportConfigSchema,
  allowedToolPatterns: z.array(z.string()).default([]),
  autoApproveToolPatterns: z.array(z.string()).default([]),
  credentialRefs: z.array(McpCredentialRefSchema).default([]),
  networkHosts: z.array(z.string()).default([]),
  sandboxProfileId: z.string().optional(),
  riskClass: McpServerRiskClassSchema.default('medium'),
  createdBy: z.string().optional(),
  requestedReason: z.string().optional(),
});
export type ConnectMcpServerRequest = z.infer<
  typeof ConnectMcpServerRequestSchema
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
  required: z.boolean().optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  allowedToolPatterns: z.array(z.string()).optional(),
});
export type UpdateAgentMcpServerBindingRequest = z.infer<
  typeof UpdateAgentMcpServerBindingRequestSchema
>;
