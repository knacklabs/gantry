import type { JsonSchema } from './openapi-route-helpers.js';

const isoDateTime = { type: 'string', format: 'date-time' };
const metadata = { type: 'object', additionalProperties: true };
const stringArray = { type: 'array', items: { type: 'string' } };
const envelope = (name: string, schema: JsonSchema): JsonSchema => ({
  type: 'object',
  required: [name],
  properties: { [name]: schema },
});
const arrayEnvelope = (name: string, itemRef: string): JsonSchema =>
  envelope(name, {
    type: 'array',
    items: { $ref: `#/components/schemas/${itemRef}` },
  });

export const automationOpenApiSchemas: Record<string, JsonSchema> = {
  Job: {
    type: 'object',
    required: ['id', 'name', 'status', 'kind'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      prompt: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused', 'deleted'] },
      kind: { type: 'string', enum: ['manual', 'once', 'recurring'] },
      runAt: isoDateTime,
      schedule: metadata,
      executionContext: metadata,
      notificationRoutes: { type: 'array', items: metadata },
      setup: metadata,
      modelAlias: { type: 'string' },
    },
  },
  JobListResponse: arrayEnvelope('jobs', 'Job'),
  JobCreateRequest: {
    type: 'object',
    required: ['name', 'prompt', 'executionContext'],
    properties: {
      name: { type: 'string' },
      prompt: { type: 'string' },
      executionContext: metadata,
      notificationRoutes: { type: 'array', items: metadata },
      capabilityRequirements: { type: 'array', items: metadata },
      requiredTools: stringArray,
      requiredMcpServers: stringArray,
      kind: { type: 'string', enum: ['manual', 'once', 'recurring'] },
      runAt: isoDateTime,
      schedule: metadata,
      modelAlias: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
  },
  JobCreateResponse: {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      dryRun: { type: 'boolean' },
      status: { type: 'string' },
      setup: metadata,
      runtimeContext: metadata,
      modelAlias: { type: 'string' },
      modelSource: { type: 'string' },
    },
  },
  JobUpdateRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      prompt: { type: 'string' },
      executionContext: metadata,
      notificationRoutes: { type: 'array', items: metadata },
      capabilityRequirements: { type: 'array', items: metadata },
      requiredTools: stringArray,
      requiredMcpServers: stringArray,
      status: { type: 'string', enum: ['active', 'paused'] },
      modelAlias: { type: 'string' },
    },
  },
  JobEventListResponse: {
    type: 'object',
    required: ['events'],
    properties: {
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/RuntimeEvent' },
      },
    },
  },
  JobPauseResponse: metadata,
  JobResumeResponse: {
    type: 'object',
    required: ['resumed'],
    properties: {
      resumed: { type: 'boolean' },
      setup: metadata,
    },
  },
  JobTriggerResponse: {
    type: 'object',
    required: ['triggerId'],
    properties: { triggerId: { type: 'string' } },
  },
  DeleteResponse: {
    type: 'object',
    required: ['deleted'],
    properties: { deleted: { type: 'boolean' } },
  },
  TriggerWaitResponse: metadata,
  Webhook: {
    type: 'object',
    required: ['webhookId', 'appId', 'name', 'url', 'enabled'],
    properties: {
      webhookId: { type: 'string' },
      appId: { type: 'string' },
      name: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      enabled: { type: 'boolean' },
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  WebhookListResponse: arrayEnvelope('webhooks', 'Webhook'),
  WebhookRequest: {
    type: 'object',
    required: ['name', 'url'],
    properties: {
      name: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      secret: { type: 'string' },
      enabled: { type: 'boolean' },
    },
  },
  WebhookTestResponse: {
    type: 'object',
    required: ['accepted', 'eventId'],
    properties: {
      accepted: { type: 'boolean' },
      eventId: { type: 'integer' },
    },
  },
  CountResponse: {
    type: 'object',
    additionalProperties: { type: 'integer' },
  },
  ExternalIngress: {
    type: 'object',
    required: ['ingressId', 'appId', 'name', 'enabled'],
    properties: {
      ingressId: { type: 'string' },
      appId: { type: 'string' },
      name: { type: 'string' },
      enabled: { type: 'boolean' },
      metadata,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  ExternalIngressListResponse: {
    type: 'array',
    items: { $ref: '#/components/schemas/ExternalIngress' },
  },
  ExternalIngressRequest: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      enabled: { type: 'boolean' },
      metadata,
    },
  },
  ExternalIngressInvokeRequest: metadata,
  ExternalIngressInvokeResponse: metadata,
};
