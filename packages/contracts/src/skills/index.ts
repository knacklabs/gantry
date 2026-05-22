import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const SkillActionPermissionResponseSchema = z.object({
  id: z.string(),
  capabilityId: z.string(),
  displayName: z.string(),
  risk: z.enum(['read', 'write', 'admin']),
  can: z.string(),
  cannot: z.string(),
  requiredEnvVars: z.array(z.string()),
  commandTemplates: z.array(z.string()),
});

export const SkillCatalogItemResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  version: z.string(),
  source: z
    .enum(['bundled', 'agent_created', 'admin_uploaded', 'provider_managed'])
    .optional(),
  status: z.enum(['draft', 'approved', 'rejected', 'disabled']).optional(),
  promptRefs: z.array(z.string()),
  toolIds: z.array(z.string()),
  workflowRefs: z.array(z.string()),
  requiredEnvVars: z.array(z.string()).optional(),
  actionPermissions: z.array(SkillActionPermissionResponseSchema).optional(),
  storage: z
    .object({
      storageType: z.enum(['local-filesystem', 'object-store']),
      storageRef: z.string(),
      contentHash: z.string(),
      sizeBytes: z.number(),
    })
    .optional(),
  providerRef: z
    .object({
      provider: z.string(),
      skillId: z.string(),
      type: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  createdBy: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: IsoDateTimeSchema.optional(),
  rejectedBy: z.string().optional(),
  rejectedAt: IsoDateTimeSchema.optional(),
  setupRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type SkillCatalogItemResponse = z.infer<
  typeof SkillCatalogItemResponseSchema
>;

export const UploadSkillDraftContextSchema = z.object({
  appId: z.string().optional(),
  agentId: z.string().optional(),
  createdBy: z.string().optional(),
});
export type UploadSkillDraftContext = z.infer<
  typeof UploadSkillDraftContextSchema
>;

export const ApproveSkillDraftRequestSchema = z.object({
  appId: z.string().optional(),
  approvedBy: z.string().optional(),
});
export type ApproveSkillDraftRequest = z.infer<
  typeof ApproveSkillDraftRequestSchema
>;

export const RejectSkillDraftRequestSchema = z.object({
  appId: z.string().optional(),
  rejectedBy: z.string().optional(),
});
export type RejectSkillDraftRequest = z.infer<
  typeof RejectSkillDraftRequestSchema
>;

export const UpdateAgentSkillBindingRequestSchema = z.object({
  appId: z.string().optional(),
});
export type UpdateAgentSkillBindingRequest = z.infer<
  typeof UpdateAgentSkillBindingRequestSchema
>;
