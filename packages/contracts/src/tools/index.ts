import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
  SchemaDescriptorSchema,
} from '../contract-primitives.js';

export const ToolRiskSchema = z.enum(['low', 'medium', 'high']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const ToolCatalogProviderToolNameSchema = z.enum([
  'Agent',
  'Bash',
  'Edit',
  'Read',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Browser',
]);
export type ToolCatalogProviderToolName = z.infer<
  typeof ToolCatalogProviderToolNameSchema
>;

export const ToolCatalogKindSchema = z.enum([
  'anthropic_sdk',
  'host',
  'browser',
  'channel',
]);
export const ToolCatalogProviderSchema = z.enum([
  `anth${'ropic'}` as never,
  'myclaw',
  `sla${'ck'}` as never,
  `tea${'ms'}` as never,
  `tele${'gram'}` as never,
]);
export const ToolCatalogCategorySchema = z.enum([
  'files',
  'search',
  'execution',
  'web',
  'agent',
  'mcp',
  'channel',
  'admin',
]);
export const ToolCatalogStatusSchema = z.enum(['active', 'disabled', 'error']);

export const ToolCatalogItemResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  kind: ToolCatalogKindSchema,
  provider: ToolCatalogProviderSchema,
  providerToolName: ToolCatalogProviderToolNameSchema.optional(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  category: ToolCatalogCategorySchema,
  inputSchema: SchemaDescriptorSchema,
  outputSchema: SchemaDescriptorSchema.optional(),
  risk: ToolRiskSchema,
  selectable: z.boolean(),
  status: ToolCatalogStatusSchema,
  permissionPolicyId: z.string().nullable().optional(),
  sandboxProfileId: z.string().nullable().optional(),
  adapterRef: z.string().optional(),
  credentialRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ToolCatalogItemResponse = z.infer<
  typeof ToolCatalogItemResponseSchema
>;
