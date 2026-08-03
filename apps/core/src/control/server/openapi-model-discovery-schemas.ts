import type { JsonSchema } from './openapi-route-helpers.js';

const stringArray = { type: 'array', items: { type: 'string' } };

export const providerModelOpenApiSchemas: Record<string, JsonSchema> = {
  ProviderModelListingResponse: {
    type: 'object',
    required: [
      'providerId',
      'providerLabel',
      'discoverySource',
      'refreshedAt',
      'refreshError',
      'models',
    ],
    additionalProperties: false,
    properties: {
      providerId: { type: 'string' },
      providerLabel: { type: 'string' },
      discoverySource: { type: 'string', enum: ['live', 'cache', 'none'] },
      refreshedAt: { type: ['string', 'null'], format: 'date-time' },
      refreshError: { type: ['string', 'null'] },
      models: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'providerModelId',
            'displayName',
            'aliases',
            'registered',
            'availability',
            'source',
            'deprecated',
          ],
          additionalProperties: false,
          properties: {
            providerModelId: { type: 'string' },
            displayName: { type: 'string' },
            aliases: stringArray,
            registered: { type: 'boolean' },
            availability: {
              type: 'string',
              enum: [
                'ready',
                'available_to_register',
                'configured_not_advertised',
                'availability_unknown',
              ],
            },
            source: {
              type: 'string',
              enum: ['registered', 'live', 'registered_and_live'],
            },
            deprecated: { type: 'boolean' },
          },
        },
      },
    },
  },
  RegisterProviderModelRequest: {
    type: 'object',
    required: ['providerId', 'providerModelId', 'alias', 'expectedRevision'],
    additionalProperties: false,
    properties: {
      providerId: { type: 'string', minLength: 1, maxLength: 96 },
      providerModelId: { type: 'string', minLength: 1, maxLength: 512 },
      alias: {
        type: 'string',
        minLength: 1,
        maxLength: 96,
        pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
      },
      expectedRevision: { type: 'integer', minimum: 0 },
    },
  },
  RegisterProviderModelResponse: {
    type: 'object',
    required: ['revision', 'alias', 'providerId', 'providerModelId'],
    additionalProperties: false,
    properties: {
      revision: { type: 'integer', minimum: 0 },
      alias: { type: 'string' },
      providerId: { type: 'string' },
      providerModelId: { type: 'string' },
    },
  },
};
