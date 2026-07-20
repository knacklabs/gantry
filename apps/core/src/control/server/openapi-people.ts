import {
  doc,
  ids,
  query,
  type JsonSchema,
  type RouteDoc,
} from './openapi-route-helpers.js';

const ref = (name: string): JsonSchema => ({
  $ref: `#/components/schemas/${name}`,
});
const isoDateTime = { type: 'string', format: 'date-time' };
const nullableString = { type: ['string', 'null'] };
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
const metadata = { type: 'object', additionalProperties: true };

const personAlias = ref('PersonAlias');
const mergeConflict = ref('PersonMergeConflict');
const mergeResponseRequired = [
  'sourcePersonId',
  'targetPersonId',
  'aliasesToMove',
  'memoryRowsToMove',
  'excludedMemoryScopes',
  'conflicts',
];
const mergeResponseProperties = {
  sourcePersonId: { type: 'string' },
  targetPersonId: { type: 'string' },
  aliasesToMove: { type: 'array', items: personAlias },
  memoryRowsToMove: { type: 'integer', minimum: 0 },
  memoryRowsFingerprint: { type: 'string' },
  excludedMemoryScopes: {
    type: 'object',
    required: ['group', 'channel', 'common'],
    properties: {
      group: { type: 'integer', minimum: 0 },
      channel: { type: 'integer', minimum: 0 },
      common: { type: 'integer', minimum: 0 },
    },
  },
  conflicts: { type: 'array', items: mergeConflict },
};

export const peopleOpenApiSchemas: Record<string, JsonSchema> = {
  PersonAliasVerificationStatus: {
    type: 'string',
    enum: ['verified', 'unverified', 'retired'],
  },
  IdentityEvidenceType: {
    type: 'string',
    enum: ['provider_user', 'email', 'phone', 'web_user'],
  },
  PersonAlias: {
    type: 'object',
    required: [
      'id',
      'appId',
      'personId',
      'provider',
      'externalUserId',
      'verificationStatus',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      personId: { type: 'string' },
      provider: { type: 'string' },
      providerAccountId: nullableString,
      externalUserId: { type: 'string' },
      displayName: nullableString,
      verificationStatus: ref('PersonAliasVerificationStatus'),
      verifiedAt: nullableDateTime,
      verifiedBy: nullableString,
      retiredAt: nullableDateTime,
      retiredBy: nullableString,
      evidence: metadata,
      metadata,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  PersonMemoryCounts: {
    type: 'object',
    required: ['personal', 'active', 'archived', 'superseded', 'deleted'],
    properties: {
      personal: { type: 'integer', minimum: 0 },
      active: { type: 'integer', minimum: 0 },
      archived: { type: 'integer', minimum: 0 },
      superseded: { type: 'integer', minimum: 0 },
      deleted: { type: 'integer', minimum: 0 },
    },
  },
  PersonAliasCounts: {
    type: 'object',
    required: ['verified', 'unverified', 'retired'],
    properties: {
      verified: { type: 'integer', minimum: 0 },
      unverified: { type: 'integer', minimum: 0 },
      retired: { type: 'integer', minimum: 0 },
    },
  },
  Person: {
    type: 'object',
    required: ['personId', 'appId', 'kind', 'status', 'createdAt', 'updatedAt'],
    properties: {
      personId: { type: 'string' },
      appId: { type: 'string' },
      kind: { type: 'string', enum: ['human', 'service'] },
      displayName: nullableString,
      status: { type: 'string', enum: ['active', 'disabled', 'archived'] },
      aliases: { type: 'array', items: personAlias },
      memoryCounts: ref('PersonMemoryCounts'),
      aliasCounts: ref('PersonAliasCounts'),
      metadata,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  PeopleListResponse: {
    type: 'object',
    required: ['people', 'nextCursor'],
    properties: {
      people: { type: 'array', items: ref('Person') },
      nextCursor: nullableString,
    },
  },
  PersonGetResponse: {
    type: 'object',
    required: ['person'],
    properties: { person: ref('Person') },
  },
  IdentityResolveRequest: {
    type: 'object',
    required: ['provider', 'externalUserId', 'evidenceType'],
    properties: {
      appId: { type: 'string' },
      provider: { type: 'string' },
      providerAccountId: nullableString,
      externalUserId: { type: 'string' },
      displayName: nullableString,
      evidenceType: ref('IdentityEvidenceType'),
      createIfMissing: { type: 'boolean' },
    },
  },
  IdentityResolveResponse: {
    type: 'object',
    required: ['status', 'personId', 'memoryHydrationEligible'],
    properties: {
      status: {
        type: 'string',
        enum: ['resolved', 'created', 'unresolved'],
      },
      personId: nullableString,
      memoryHydrationEligible: { type: 'boolean' },
      matchedAlias: personAlias,
      createdAlias: personAlias,
      verificationStatus: ref('PersonAliasVerificationStatus'),
    },
  },
  AddPersonAliasRequest: {
    type: 'object',
    required: ['provider', 'externalUserId', 'evidenceType'],
    properties: {
      appId: { type: 'string' },
      provider: { type: 'string' },
      providerAccountId: nullableString,
      externalUserId: { type: 'string' },
      displayName: nullableString,
      evidenceType: ref('IdentityEvidenceType'),
      evidence: metadata,
    },
  },
  PersonAliasMutationResponse: {
    type: 'object',
    required: ['alias'],
    properties: { alias: personAlias },
  },
  PersonMergeRequest: {
    type: 'object',
    required: ['sourcePersonId'],
    properties: {
      appId: { type: 'string' },
      sourcePersonId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      fingerprint: { type: 'string' },
      conflictResolution: {
        type: 'string',
        enum: ['fail_on_conflict', 'keep_target'],
      },
    },
  },
  PersonMergeConflict: {
    type: 'object',
    required: ['kind', 'key'],
    properties: {
      type: { type: 'string', enum: ['memory', 'alias'] },
      sourceMemoryId: { type: 'string' },
      targetMemoryId: { type: 'string' },
      sourceAliasId: { type: 'string' },
      targetAliasId: { type: 'string' },
      agentId: nullableString,
      kind: { type: 'string' },
      key: { type: 'string' },
    },
  },
  PersonMergePreviewResponse: {
    type: 'object',
    required: ['summary', ...mergeResponseRequired, 'fingerprint'],
    properties: {
      summary: { const: 'Merge preview only. No data changed.' },
      ...mergeResponseProperties,
      fingerprint: { type: 'string' },
    },
  },
  PersonMergeApplyResponse: {
    type: 'object',
    required: [
      'summary',
      ...mergeResponseRequired,
      'idempotencyKey',
      'auditId',
      'applied',
      'fingerprint',
    ],
    properties: {
      summary: {
        const:
          'Person merge completed. Personal memory and aliases now belong to the target person.',
      },
      ...mergeResponseProperties,
      fingerprint: { type: 'string' },
      idempotencyKey: { type: 'string' },
      auditId: { type: 'string' },
      applied: { type: 'boolean' },
    },
  },
};

export const peopleOpenApiResponseSchemas: Record<string, JsonSchema> = {
  resolveIdentity: ref('IdentityResolveResponse'),
  listPeople: ref('PeopleListResponse'),
  getPerson: ref('PersonGetResponse'),
  addPersonAlias: ref('PersonAliasMutationResponse'),
  retirePersonAlias: ref('PersonAliasMutationResponse'),
  previewPersonMerge: ref('PersonMergePreviewResponse'),
  mergePerson: ref('PersonMergeApplyResponse'),
};

export const peopleOpenApiRequestSchemas: Record<string, JsonSchema> = {
  resolveIdentity: ref('IdentityResolveRequest'),
  addPersonAlias: ref('AddPersonAliasRequest'),
  previewPersonMerge: ref('PersonMergeRequest'),
  mergePerson: ref('PersonMergeRequest'),
};

const appIdQuery = query('appId', 'App id. Defaults to API key app.');
const peopleLimitQuery = query(
  'limit',
  'Maximum people to return. Defaults to 50.',
  { type: 'integer', minimum: 1, maximum: 200, default: 50 },
);
const peopleCursorQuery = query(
  'cursor',
  'Opaque cursor returned by the previous page.',
);

export const peopleOpenApiRouteDocs: RouteDoc[] = [
  doc(
    'post',
    '/v1/identity/resolve',
    'resolveIdentity',
    'People',
    'Resolve identity',
    'Resolves provider identity evidence to an app-scoped person for host-owned memory hydration.',
    ['identity:resolve'],
    { body: 'json' },
  ),
  doc(
    'get',
    '/v1/people',
    'listPeople',
    'People',
    'List people',
    'Lists app-scoped people with aliases and personal memory counts.',
    ['people:read'],
    { parameters: [appIdQuery, peopleLimitQuery, peopleCursorQuery] },
  ),
  doc(
    'get',
    '/v1/people/{personId}',
    'getPerson',
    'People',
    'Get person',
    'Reads one app-scoped person with aliases and personal memory counts.',
    ['people:read'],
    { parameters: [ids.person, appIdQuery] },
  ),
  doc(
    'post',
    '/v1/people/{personId}/aliases',
    'addPersonAlias',
    'People',
    'Add person alias',
    'Links an alias to a person as verified after admin review.',
    ['people:admin'],
    { body: 'json', parameters: [ids.person], status: '201' },
  ),
  doc(
    'delete',
    '/v1/people/{personId}/aliases/{aliasId}',
    'retirePersonAlias',
    'People',
    'Retire person alias',
    'Retires an alias without deleting personal memory.',
    ['people:admin'],
    { body: 'none', parameters: [ids.person, ids.alias, appIdQuery] },
  ),
  doc(
    'post',
    '/v1/people/{personId}/merge:preview',
    'previewPersonMerge',
    'People',
    'Preview person merge',
    'Reports aliases, personal memory rows, excluded scopes, and conflicts without writing changes.',
    ['people:admin'],
    { body: 'json', parameters: [ids.person] },
  ),
  doc(
    'post',
    '/v1/people/{personId}/merge',
    'mergePerson',
    'People',
    'Merge person',
    'Atomically moves aliases and user-scoped personal memory to the target person.',
    ['people:admin'],
    { body: 'json', parameters: [ids.person] },
  ),
];
