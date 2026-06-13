import { z } from 'zod';

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const ContractMetadataSchema = z.record(z.string(), z.unknown());
export type ContractMetadata = z.infer<typeof ContractMetadataSchema>;

export const ExternalReferenceSchema = z.object({
  kind: z.string().optional(),
  id: z.string(),
  displayName: z.string().optional(),
  providerId: z.string().optional(),
  installationId: z.string().optional(),
  metadata: ContractMetadataSchema.optional(),
  raw: ContractMetadataSchema.optional(),
});
export type ExternalReference = z.infer<typeof ExternalReferenceSchema>;

export const RuntimeLimitSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type RuntimeLimit = z.infer<typeof RuntimeLimitSchema>;

export const SchemaDescriptorSchema = z.object({
  format: z
    .enum(['json-schema', 'zod', 'openapi', 'unknown'])
    .default('unknown'),
  schema: ContractMetadataSchema,
});
export type SchemaDescriptor = z.infer<typeof SchemaDescriptorSchema>;

// Derived agent-engine vocabulary. Display labels are "Anthropic SDK" and
// "DeepAgents". The engine is no longer user-selectable: it is derived from the
// resolved model's provider and surfaced only as a read-only diagnostic. The
// runtime mirrors this enum in apps/core/src/shared/agent-engine.ts.
export const AgentEngineSchema = z.enum(['anthropic_sdk', 'deepagents']);
export type AgentEngine = z.infer<typeof AgentEngineSchema>;

export const LlmProfileRefSchema = z.object({
  id: z.string().optional(),
  purpose: z.string().optional(),
  modelAlias: z.string().optional(),
  credentialProfileRef: z.string().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type LlmProfileRef = z.infer<typeof LlmProfileRefSchema>;
