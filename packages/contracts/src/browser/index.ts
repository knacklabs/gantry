import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const BrowserProfileStatusSchema = z.enum([
  'active',
  'inactive',
  'disabled',
  'archived',
]);
export type BrowserProfileStatus = z.infer<typeof BrowserProfileStatusSchema>;

export const BrowserProfileResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string().nullable().optional(),
  name: z.string(),
  status: BrowserProfileStatusSchema,
  stateRef: z.string().nullable().optional(),
  authMarkers: z.array(z.string()).optional(),
  usagePolicyRef: z.string().nullable().optional(),
  externalRef: ExternalReferenceSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type BrowserProfileResponse = z.infer<
  typeof BrowserProfileResponseSchema
>;
