import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { JsonSchema } from './openapi-route-helpers.js';

const isoDateTime = { type: 'string', format: 'date-time' };
const metadata = { type: 'object', additionalProperties: true };
const stringArray = { type: 'array', items: { type: 'string' } };
const webhookEventTypes = {
  type: ['array', 'null'],
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string', enum: Object.values(RUNTIME_EVENT_TYPES) },
};
const webhookSubscriptionProperties = {
  eventTypes: webhookEventTypes,
  agentId: { type: ['string', 'null'] },
  sessionId: { type: ['string', 'null'] },
  jobId: { type: ['string', 'null'] },
};
const capabilityRequirementImplementation = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: ['configured_access', 'local_cli', 'mcp_server', 'builtin_tool'],
    },
    name: { type: 'string' },
    executablePath: { type: 'string' },
    executableVersion: { type: 'string' },
    executableHash: { type: 'string' },
    commandTemplate: { type: 'string' },
    authPreflight: { type: 'string' },
    protectedPaths: stringArray,
  },
};
const accessRequirement = {
  type: 'object',
  required: ['target'],
  properties: {
    target: {
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'rule'],
          properties: {
            kind: { type: 'string', enum: ['tool_rule'] },
            rule: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'capabilityId'],
          properties: {
            kind: { type: 'string', enum: ['capability'] },
            capabilityId: { type: 'string' },
            implementation: capabilityRequirementImplementation,
          },
        },
        {
          type: 'object',
          required: ['kind', 'server'],
          properties: {
            kind: { type: 'string', enum: ['mcp_server'] },
            server: { type: 'string' },
          },
        },
      ],
    },
    reason: { type: 'string' },
  },
};
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
      accessRequirements: {
        type: 'array',
        items: accessRequirement,
      },
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
      accessRequirements: {
        type: 'array',
        items: accessRequirement,
      },
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
      accessRequirements: {
        type: 'array',
        items: accessRequirement,
      },
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
    required: [
      'webhookId',
      'appId',
      'name',
      'url',
      'enabled',
      'eventTypes',
      'agentId',
      'sessionId',
      'jobId',
    ],
    additionalProperties: false,
    properties: {
      webhookId: { type: 'string' },
      appId: { type: 'string' },
      name: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      enabled: { type: 'boolean' },
      ...webhookSubscriptionProperties,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  WebhookListResponse: arrayEnvelope('webhooks', 'Webhook'),
  WebhookCreateRequest: {
    type: 'object',
    required: ['name', 'url'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      secret: { type: 'string' },
      enabled: { type: 'boolean' },
      ...webhookSubscriptionProperties,
    },
  },
  WebhookUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      secret: { type: 'string' },
      enabled: { type: 'boolean' },
      ...webhookSubscriptionProperties,
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
  ExternalIngressConversationMessageTarget: {
    type: 'object',
    required: ['kind', 'conversationId', 'message'],
    properties: {
      kind: { type: 'string', enum: ['conversation_message'] },
      conversationId: { type: 'string' },
      threadId: { type: 'string' },
      agentId: { type: 'string' },
      message: { type: 'string' },
      senderId: { type: 'string' },
      senderName: { type: 'string' },
      messageRef: { type: 'string' },
      correlationId: { type: 'string' },
    },
  },
  ExternalIngressInvokeRequest: {
    type: 'object',
    required: ['target'],
    properties: {
      appId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      target: {
        oneOf: [
          {
            $ref: '#/components/schemas/ExternalIngressConversationMessageTarget',
          },
          metadata,
        ],
      },
    },
  },
  ExternalIngressInvokeResponse: {
    type: 'object',
    properties: {
      invocationId: { type: 'string' },
      duplicate: { type: 'boolean' },
      targetKind: { type: 'string' },
      messageId: { type: 'string' },
      acceptedEventId: { type: 'integer' },
      conversationId: { type: 'string' },
      threadId: { type: 'string', nullable: true },
      sessionId: { type: 'string' },
      jobId: { type: 'string' },
      triggerId: { type: 'string' },
    },
    additionalProperties: true,
  },
};
