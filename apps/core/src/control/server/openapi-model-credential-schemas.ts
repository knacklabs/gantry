import type { JsonSchema } from './openapi-route-helpers.js';

const isoDateTime = { type: 'string', format: 'date-time' };
const stringArray = { type: 'array', items: { type: 'string' } };

const modelCredentialModeSchema: JsonSchema = {
  type: 'object',
  required: [
    'id',
    'label',
    'helpText',
    'schemaVersion',
    'gatewayAuthStrategy',
    'fields',
  ],
  properties: {
    id: { type: 'string', example: 'api_key' },
    label: { type: 'string' },
    helpText: { type: 'string' },
    schemaVersion: { type: 'number' },
    gatewayAuthStrategy: { type: 'string' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'label', 'secret', 'required'],
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          secret: { type: 'boolean' },
          required: { type: 'boolean' },
        },
      },
    },
  },
};

const fieldFingerprintsSchema: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['field', 'fingerprint'],
    properties: {
      field: { type: 'string' },
      fingerprint: { type: 'string' },
    },
  },
};

const modelCredentialStatusProperties: JsonSchema['properties'] = {
  providerId: { type: 'string', example: 'provider-id' },
  label: { type: 'string' },
  role: {
    type: 'string',
    enum: ['model_route', 'embedding_provider', 'provider'],
  },
  configured: { type: 'boolean' },
  authMode: { type: ['string', 'null'], example: 'api_key' },
  status: { type: 'string', enum: ['active', 'disabled'] },
  health: { type: 'string', enum: ['ready', 'missing', 'disabled'] },
  fingerprint: { type: ['string', 'null'], example: 'sha256:0123abcd' },
  fieldFingerprints: fieldFingerprintsSchema,
  schemaVersion: { type: 'number' },
  configuredFields: stringArray,
  credentialModes: {
    type: 'array',
    items: modelCredentialModeSchema,
  },
  supportedWorkloads: stringArray,
  updatedAt: { oneOf: [isoDateTime, { type: 'null' }] },
};

const modelCredentialStatusRequired = [
  'providerId',
  'configured',
  'status',
  'health',
  'credentialModes',
];

export const modelCredentialSchemas: Record<string, JsonSchema> = {
  ModelCredentialStatus: {
    type: 'object',
    required: modelCredentialStatusRequired,
    properties: modelCredentialStatusProperties,
  },
  ModelCredentialListResponse: {
    type: 'object',
    required: ['providers'],
    properties: {
      providers: {
        type: 'array',
        items: { $ref: '#/components/schemas/ModelCredentialStatus' },
      },
    },
  },
  ModelCredentialWriteRequest: {
    type: 'object',
    required: ['payload'],
    additionalProperties: false,
    properties: {
      authMode: {
        type: 'string',
        example: 'api_key',
        description:
          'Provider credential mode. Omit when the provider has one mode.',
      },
      payload: {
        type: 'object',
        additionalProperties: { type: 'string', writeOnly: true },
        description:
          'Provider-specific credential payload. Stored encrypted; never returned by read APIs.',
      },
    },
  },
  ModelCredentialPatchRequest: {
    type: 'object',
    required: ['payload'],
    additionalProperties: false,
    properties: {
      payload: {
        type: 'object',
        additionalProperties: { type: 'string', writeOnly: true },
        description:
          'Provider-specific credential fields to rotate for the existing authMode. Stored encrypted; never returned by read APIs.',
      },
    },
  },
  ModelCredentialMutationResponse: {
    type: 'object',
    required: modelCredentialStatusRequired,
    properties: modelCredentialStatusProperties,
  },
};
