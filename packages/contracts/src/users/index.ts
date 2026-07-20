import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const PersonBaseResponseSchema = z.object({
  personId: z.string(),
  appId: z.string(),
  kind: z.enum(['human', 'service']).default('human'),
  displayName: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled', 'archived']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type PersonBaseResponse = z.infer<typeof PersonBaseResponseSchema>;

export const PersonAliasVerificationStatusSchema = z.enum([
  'verified',
  'unverified',
  'retired',
]);
export type PersonAliasVerificationStatus = z.infer<
  typeof PersonAliasVerificationStatusSchema
>;

export const PersonAliasResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  personId: z.string(),
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
export type PersonAliasResponse = z.infer<typeof PersonAliasResponseSchema>;

export const PersonResponseSchema = PersonBaseResponseSchema.extend({
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

export const PEOPLE_LIST_DEFAULT_LIMIT = 50;
export const PEOPLE_LIST_MAX_LIMIT = 200;

export const PeopleListQuerySchema = z.object({
  appId: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PEOPLE_LIST_MAX_LIMIT)
    .default(PEOPLE_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
});
export type PeopleListQuery = z.input<typeof PeopleListQuerySchema>;

export const PeopleListResponseSchema = z.object({
  people: z.array(PersonResponseSchema),
  nextCursor: z.string().nullable(),
});
export type PeopleListResponse = z.infer<typeof PeopleListResponseSchema>;

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
  providerAccountId: z.string().nullable().optional(),
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
  appId: z.string().optional(),
  provider: z.string(),
  providerAccountId: z.string().nullable().optional(),
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
  appId: z.string().optional(),
  sourcePersonId: z.string(),
  idempotencyKey: z.string().optional(),
  fingerprint: z.string().min(1).optional(),
  conflictResolution: PersonMergeConflictResolutionSchema.optional(),
});
export type PersonMergeRequest = z.infer<typeof PersonMergeRequestSchema>;

export const PersonMergeApplyRequestSchema = PersonMergeRequestSchema.extend({
  fingerprint: z.string().min(1),
});
export type PersonMergeApplyRequest = z.infer<
  typeof PersonMergeApplyRequestSchema
>;

export const PersonMergePreviewResponseSchema = z.object({
  summary: z.literal('Merge preview only. No data changed.'),
  sourcePersonId: z.string(),
  targetPersonId: z.string(),
  aliasesToMove: z.array(PersonAliasResponseSchema),
  memoryRowsToMove: z.number().int().min(0),
  memoryRowsFingerprint: z.string().optional(),
  excludedMemoryScopes: z.object({
    group: z.number().int().min(0),
    channel: z.number().int().min(0),
    common: z.number().int().min(0),
  }),
  conflicts: z.array(
    z.object({
      type: z.enum(['memory', 'alias']).optional(),
      sourceMemoryId: z.string().optional(),
      targetMemoryId: z.string().optional(),
      sourceAliasId: z.string().optional(),
      targetAliasId: z.string().optional(),
      agentId: z.string().nullable().optional(),
      kind: z.string(),
      key: z.string(),
    }),
  ),
  fingerprint: z.string(),
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
