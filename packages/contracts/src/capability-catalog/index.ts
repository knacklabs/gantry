import { z } from 'zod';

import { McpServerDefinitionResponseSchema } from '../mcp-servers/index.js';
import { SkillCatalogItemResponseSchema } from '../skills/index.js';
import { ToolCatalogItemResponseSchema } from '../tools/index.js';

export const CapabilityCatalogResponseSchema = z.object({
  tools: z.array(ToolCatalogItemResponseSchema),
  skills: z.array(SkillCatalogItemResponseSchema),
  mcpServers: z.array(McpServerDefinitionResponseSchema),
});
export type CapabilityCatalogResponse = z.infer<
  typeof CapabilityCatalogResponseSchema
>;

export const ReviewedMcpCapabilityManifestSchema = z
  .object({
    capabilityId: z.string().trim().min(1),
    version: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1),
    category: z.string().trim().min(1),
    risk: z.enum(['read', 'write', 'admin']),
    can: z.string().trim().min(1),
    cannot: z.string().trim().min(1),
    credentialSource: z.literal('configured_access'),
    implementationBindings: z
      .array(
        z
          .object({
            kind: z.literal('mcp_tool'),
            mcpTool: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    operations: z
      .array(
        z
          .object({
            mcpTool: z.string().trim().min(1),
            schemaDialect: z.literal('json-schema-draft-07'),
            inputSchema: z.record(z.string(), z.unknown()),
            inputSchemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            resultEnvelopeSchema: z.record(z.string(), z.unknown()).optional(),
            resultEnvelopeSchemaDigest: z
              .string()
              .regex(/^sha256:[a-f0-9]{64}$/)
              .optional(),
            executionMode: z.enum(['sync', 'durable_async']).optional(),
            requiresActiveJob: z.boolean().optional(),
            deadlineMs: z.number().int().min(1_000).max(86_400_000).optional(),
            suspensionCheckpoint: z
              .object({
                milestone: z.string().trim().min(1).max(120),
                payloadPatch: z.record(z.string(), z.unknown()),
                invocationRefPath: z
                  .array(z.string().trim().min(1).max(120))
                  .min(1)
                  .max(16),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
  })
  .strict();
export type ReviewedMcpCapabilityManifest = z.infer<
  typeof ReviewedMcpCapabilityManifestSchema
>;
