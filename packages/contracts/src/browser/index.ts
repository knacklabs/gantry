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

export const BROWSER_IPC_ACTIONS = [
  'browser_profile_list',
  'browser_launch',
  'browser_close',
  'browser_status',
] as const;

export const BrowserIpcActionSchema = z.enum(BROWSER_IPC_ACTIONS);
export type BrowserIpcAction = (typeof BROWSER_IPC_ACTIONS)[number];

export const BrowserIpcRequestSchema = z.object({
  requestId: z.string(),
  action: BrowserIpcActionSchema,
  payload: ContractMetadataSchema.optional(),
  context: ContractMetadataSchema.optional(),
});
export type BrowserIpcRequest = z.infer<typeof BrowserIpcRequestSchema>;

export const BrowserIpcResponseSchema = z.object({
  ok: z.boolean(),
  requestId: z.string(),
  provider: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type BrowserIpcResponse = z.infer<typeof BrowserIpcResponseSchema>;
