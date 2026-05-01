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
