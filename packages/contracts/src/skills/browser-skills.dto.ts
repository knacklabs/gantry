import { z } from 'zod';

import { IsoDateTimeSchema } from '../contract-primitives.js';

export const BrowserSkillActionResponseSchema = z
  .object({
    id: z.string(),
    capabilityId: z.string(),
    displayName: z.string(),
    risk: z.enum(['read', 'write', 'admin']),
    can: z.string(),
    cannot: z.string(),
    networkHosts: z.array(z.string()),
  })
  .strict();
export type BrowserSkillActionResponse = z.infer<
  typeof BrowserSkillActionResponseSchema
>;

export const BrowserSkillAttachedAgentResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['active', 'disabled']),
  })
  .strict();
export type BrowserSkillAttachedAgentResponse = z.infer<
  typeof BrowserSkillAttachedAgentResponseSchema
>;

export const BrowserSkillResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    source: z.enum(['bundled', 'agent_created', 'admin_uploaded']),
    status: z.enum(['installed', 'disabled']),
    sizeBytes: z.number().int().nonnegative(),
    actions: z.array(BrowserSkillActionResponseSchema),
    attachedAgents: z.array(BrowserSkillAttachedAgentResponseSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type BrowserSkillResponse = z.infer<typeof BrowserSkillResponseSchema>;

export const BrowserSkillInventoryResponseSchema = z
  .object({
    role: z.enum(['administrator', 'viewer']),
    skills: z.array(BrowserSkillResponseSchema),
  })
  .strict();
export type BrowserSkillInventoryResponse = z.infer<
  typeof BrowserSkillInventoryResponseSchema
>;

export const BrowserSkillFileMetadataResponseSchema = z
  .object({
    path: z.string(),
    contentType: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative(),
    isText: z.boolean(),
  })
  .strict();
export type BrowserSkillFileMetadataResponse = z.infer<
  typeof BrowserSkillFileMetadataResponseSchema
>;

export const BrowserSkillFilesResponseSchema = z
  .object({
    skillId: z.string(),
    files: z.array(BrowserSkillFileMetadataResponseSchema),
  })
  .strict();
export type BrowserSkillFilesResponse = z.infer<
  typeof BrowserSkillFilesResponseSchema
>;

export const BrowserSkillFileResponseSchema = z
  .object({
    skillId: z.string(),
    file: BrowserSkillFileMetadataResponseSchema.extend({
      content: z.string().nullable(),
    }).strict(),
  })
  .strict();
export type BrowserSkillFileResponse = z.infer<
  typeof BrowserSkillFileResponseSchema
>;

export const BrowserInstallSkillRequestSchema = z.instanceof(Uint8Array);
export type BrowserInstallSkillRequest = z.infer<
  typeof BrowserInstallSkillRequestSchema
>;

export const BrowserInstallSkillResponseSchema = z
  .object({ skill: BrowserSkillResponseSchema })
  .strict();
export type BrowserInstallSkillResponse = z.infer<
  typeof BrowserInstallSkillResponseSchema
>;

export const ReplaceBrowserSkillAttachmentsRequestSchema = z
  .object({
    agentIds: z
      .array(z.string().trim().min(1))
      .max(100)
      .superRefine((agentIds, context) => {
        if (new Set(agentIds).size !== agentIds.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'agentIds must be distinct',
          });
        }
      }),
  })
  .strict();
export type ReplaceBrowserSkillAttachmentsRequest = z.infer<
  typeof ReplaceBrowserSkillAttachmentsRequestSchema
>;

export const BrowserSkillAttachmentAgentResponseSchema =
  BrowserSkillAttachedAgentResponseSchema.extend({
    attached: z.boolean(),
  }).strict();
export type BrowserSkillAttachmentAgentResponse = z.infer<
  typeof BrowserSkillAttachmentAgentResponseSchema
>;

export const BrowserSkillAttachmentsResponseSchema = z
  .object({
    skillId: z.string(),
    agents: z.array(BrowserSkillAttachmentAgentResponseSchema),
  })
  .strict();
export type BrowserSkillAttachmentsResponse = z.infer<
  typeof BrowserSkillAttachmentsResponseSchema
>;
