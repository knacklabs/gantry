import { z } from 'zod';

import {
  AgentHarnessSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

const AgentCreationWorkSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('configure_later') }).strict(),
  z
    .object({
      kind: z.literal('conversation'),
      conversationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scheduled_job'),
      conversationId: z.string().min(1),
      name: z.string().trim().min(1).max(80),
      instructions: z.string().trim().min(1).max(8_000),
      schedule: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

export const AgentCreationDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    agentHarness: AgentHarnessSchema,
    modelAlias: z.string().trim().min(1).max(200).nullable().optional(),
    capabilities: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            version: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    skillIds: z.array(z.string().min(1).max(200)).max(100).default([]),
    mcpServerIds: z.array(z.string().min(1).max(200)).max(100).default([]),
    toolSources: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            kind: z.string().min(1).max(100),
            version: z.string().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    delegateIds: z.array(z.string().min(1).max(200)).max(100).default([]),
    workSource: AgentCreationWorkSourceSchema.default({
      kind: 'configure_later',
    }),
  })
  .strict();
export type AgentCreationDocument = z.infer<typeof AgentCreationDocumentSchema>;

export const AgentCreationDraftStatusSchema = z.enum([
  'draft',
  'applying',
  'needs_attention',
  'completed',
]);
export const AgentCreationDraftSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive(),
    status: AgentCreationDraftStatusSchema,
    currentStep: z.string(),
    document: AgentCreationDocumentSchema,
    progress: z.record(z.string(), z.string()),
    agentId: z.string().nullable(),
    jobId: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type AgentCreationDraft = z.infer<typeof AgentCreationDraftSchema>;

export const CreateAgentCreationDraftRequestSchema = z
  .object({
    document: AgentCreationDocumentSchema,
    currentStep: z.string().min(1).max(50).default('identity'),
  })
  .strict();
export type CreateAgentCreationDraftRequest = z.infer<
  typeof CreateAgentCreationDraftRequestSchema
>;
export const UpdateAgentCreationDraftRequestSchema = z
  .object({
    document: AgentCreationDocumentSchema,
    currentStep: z.string().min(1).max(50),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type UpdateAgentCreationDraftRequest = z.infer<
  typeof UpdateAgentCreationDraftRequestSchema
>;
export const AgentCreationPreflightResponseSchema = z
  .object({ ok: z.boolean(), blockers: z.array(z.string()) })
  .strict();
export type AgentCreationPreflightResponse = z.infer<
  typeof AgentCreationPreflightResponseSchema
>;
