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
  source: z
    .enum(['bundled', 'agent_created', 'admin_uploaded', 'provider_managed'])
    .optional(),
  status: z.enum(['installed', 'disabled']).optional(),
  promptRefs: z.array(z.string()),
  toolIds: z.array(z.string()),
  workflowRefs: z.array(z.string()),
  requiredEnvVars: z.array(z.string()).optional(),
  actionPermissions: z.array(SkillActionPermissionResponseSchema).optional(),
  storage: z
    .object({
      storageType: z.enum(['local-filesystem', 'object-store']),
      storageRef: z.string(),
      sizeBytes: z.number(),
    })
    .optional(),
  providerRef: z
    .object({
      provider: z.string(),
      skillId: z.string(),
      type: z.string(),
    })
    .optional(),
  createdBy: z.string().optional(),
  setupRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type SkillCatalogItemResponse = z.infer<
  typeof SkillCatalogItemResponseSchema
>;

export const InstallSkillContextSchema = z.object({
  appId: z.string().optional(),
  agentId: z.string().optional(),
  createdBy: z.string().optional(),
});
export type InstallSkillContext = z.infer<typeof InstallSkillContextSchema>;

export const UpdateAgentSkillBindingRequestSchema = z.object({
  appId: z.string().optional(),
});
export type UpdateAgentSkillBindingRequest = z.infer<
  typeof UpdateAgentSkillBindingRequestSchema
>;
