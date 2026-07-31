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
  })
  .strict();
export type ReviewedMcpCapabilityManifest = z.infer<
  typeof ReviewedMcpCapabilityManifestSchema
>;
