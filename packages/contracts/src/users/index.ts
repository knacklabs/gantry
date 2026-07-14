import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const UserResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  kind: z.enum(['human', 'service']).default('human'),
  displayName: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled', 'archived']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const UserAliasResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  userId: z.string(),
  provider: z.string(),
  providerAccountId: z.string().nullable().optional(),
  externalUserId: z.string(),
  displayName: z.string().nullable().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type UserAliasResponse = z.infer<typeof UserAliasResponseSchema>;
