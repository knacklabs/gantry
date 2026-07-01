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

export const PersonAliasVerificationStatusSchema = z.enum([
  'verified',
  'unverified',
  'retired',
]);
export type PersonAliasVerificationStatus = z.infer<
  typeof PersonAliasVerificationStatusSchema
>;

export const UserAliasResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  userId: z.string(),
  provider: z.string(),
  providerAccountId: z.string().nullable().optional(),
  externalUserId: z.string(),
  displayName: z.string().nullable().optional(),
  verificationStatus: PersonAliasVerificationStatusSchema.default('unverified'),
  verifiedAt: IsoDateTimeSchema.nullable().optional(),
  verifiedBy: z.string().nullable().optional(),
  retiredAt: IsoDateTimeSchema.nullable().optional(),
  retiredBy: z.string().nullable().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  evidence: ContractMetadataSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type UserAliasResponse = z.infer<typeof UserAliasResponseSchema>;

export const PersonAliasResponseSchema = UserAliasResponseSchema.omit({
  userId: true,
}).extend({
  personId: z.string(),
});
export type PersonAliasResponse = z.infer<typeof PersonAliasResponseSchema>;

export const PersonResponseSchema = UserResponseSchema.omit({
  id: true,
}).extend({
  personId: z.string(),
  aliases: z.array(PersonAliasResponseSchema).optional(),
  memoryCounts: z
    .object({
      personal: z.number().int().min(0),
      active: z.number().int().min(0),
      archived: z.number().int().min(0),
      superseded: z.number().int().min(0),
      deleted: z.number().int().min(0),
    })
    .optional(),
  aliasCounts: z
    .object({
      verified: z.number().int().min(0),
      unverified: z.number().int().min(0),
      retired: z.number().int().min(0),
    })
    .optional(),
});
export type PersonResponse = z.infer<typeof PersonResponseSchema>;

export const IdentityResolveStatusSchema = z.enum([
  'resolved',
  'created',
  'unresolved',
]);
export type IdentityResolveStatus = z.infer<typeof IdentityResolveStatusSchema>;

export const IdentityEvidenceTypeSchema = z.enum([
  'provider_user',
  'email',
  'phone',
  'web_user',
]);
export type IdentityEvidenceType = z.infer<typeof IdentityEvidenceTypeSchema>;

export const IdentityResolveRequestSchema = z.object({
  appId: z.string().optional(),
  provider: z.string(),
  providerConnectionId: z.string().nullable().optional(),
  externalUserId: z.string(),
  displayName: z.string().nullable().optional(),
  evidenceType: IdentityEvidenceTypeSchema,
  createIfMissing: z.boolean().optional(),
});
export type IdentityResolveRequest = z.infer<
  typeof IdentityResolveRequestSchema
>;

export const IdentityResolveResponseSchema = z.object({
  status: IdentityResolveStatusSchema,
  personId: z.string().nullable(),
  memoryHydrationEligible: z.boolean(),
  matchedAlias: PersonAliasResponseSchema.optional(),
  createdAlias: PersonAliasResponseSchema.optional(),
  verificationStatus: PersonAliasVerificationStatusSchema.optional(),
});
export type IdentityResolveResponse = z.infer<
  typeof IdentityResolveResponseSchema
>;

export const AddPersonAliasRequestSchema = z.object({
  provider: z.string(),
  providerConnectionId: z.string().nullable().optional(),
  externalUserId: z.string(),
  displayName: z.string().nullable().optional(),
  evidenceType: IdentityEvidenceTypeSchema,
  evidence: ContractMetadataSchema.optional(),
});
export type AddPersonAliasRequest = z.infer<typeof AddPersonAliasRequestSchema>;

export const PersonMergeConflictResolutionSchema = z.enum([
  'fail_on_conflict',
  'keep_target',
]);
export type PersonMergeConflictResolution = z.infer<
  typeof PersonMergeConflictResolutionSchema
>;

export const PersonMergeRequestSchema = z.object({
  sourcePersonId: z.string(),
  idempotencyKey: z.string().optional(),
  conflictResolution: PersonMergeConflictResolutionSchema.optional(),
});
export type PersonMergeRequest = z.infer<typeof PersonMergeRequestSchema>;

export const PersonMergePreviewResponseSchema = z.object({
  summary: z.literal('Merge preview only. No data changed.'),
  sourcePersonId: z.string(),
  targetPersonId: z.string(),
  aliasesToMove: z.array(PersonAliasResponseSchema),
  memoryRowsToMove: z.number().int().min(0),
  excludedMemoryScopes: z.object({
    group: z.number().int().min(0),
    channel: z.number().int().min(0),
    common: z.number().int().min(0),
  }),
  conflicts: z.array(
    z.object({
      sourceMemoryId: z.string(),
      targetMemoryId: z.string(),
      agentId: z.string().nullable().optional(),
      kind: z.string(),
      key: z.string(),
    }),
  ),
});
export type PersonMergePreviewResponse = z.infer<
  typeof PersonMergePreviewResponseSchema
>;

export const PersonMergeApplyResponseSchema =
  PersonMergePreviewResponseSchema.omit({ summary: true }).extend({
    summary: z.literal(
      'Person merge completed. Personal memory and aliases now belong to the target person.',
    ),
    idempotencyKey: z.string(),
    auditId: z.string(),
    applied: z.boolean(),
  });
export type PersonMergeApplyResponse = z.infer<
  typeof PersonMergeApplyResponseSchema
>;
