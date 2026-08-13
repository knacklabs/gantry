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
const permissionAuthorityAddition = {
  type: 'object',
  required: ['type', 'behavior', 'rules'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['addRules', 'replaceRules'] },
    behavior: { type: 'string', enum: ['allow'] },
    rules: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        required: ['toolName'],
        additionalProperties: false,
        properties: {
          toolName: { type: 'string' },
          ruleContent: { type: 'string' },
        },
      },
    },
    destination: {
      type: 'string',
      enum: [
        'userSettings',
        'projectSettings',
        'localSettings',
        'session',
        'cliArg',
      ],
    },
  },
};
const setupAction = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'grant'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['approve_grant'] },
        grant: permissionAuthorityAddition,
      },
    },
    {
      type: 'object',
      required: ['kind', 'proposalId'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['fix_proposal'] },
        proposalId: { type: 'string' },
      },
    },
    {
      type: 'object',
      required: ['kind', 'text'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['instruction'] },
        text: { type: 'string' },
      },
    },
  ],
};
// Closed unions mirror JobSetupReadinessState / JobSetupBlocker exactly so
// the generated SDK models the actual setup contract (review R5).
const SETUP_READINESS_STATES = [
  'ready',
  'missing_capability',
  'broker_unreachable',
  'credential_unknown',
  'browser_login_may_be_required',
  'mcp_missing_credential',
];
const SETUP_BLOCKER_TYPES = [
  'tool',
  'semantic_capability',
  'browser',
  'mcp_server',
  'credential',
  'local_cli',
];
const jobSetup = {
  type: 'object',
  required: ['state', 'checkedAt', 'fingerprint', 'blockers', 'nextAction'],
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: SETUP_READINESS_STATES },
    checkedAt: { type: ['string', 'null'], format: 'date-time' },
    fingerprint: { type: ['string', 'null'] },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['state', 'summary', 'action', 'type', 'id'],
        additionalProperties: false,
        properties: {
          state: {
            type: 'string',
            enum: SETUP_READINESS_STATES.filter((state) => state !== 'ready'),
          },
          summary: { type: 'string' },
          action: setupAction,
          type: { type: 'string', enum: SETUP_BLOCKER_TYPES },
          id: { type: 'string' },
        },
      },
    },
    nextAction: { type: ['string', 'null'] },
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
  UsageAggregate: {
    type: 'object',
    required: ['requestCount', 'inputTokens', 'outputTokens'],
    additionalProperties: false,
    properties: {
      requestCount: { type: 'integer', minimum: 0 },
      inputTokens: { type: 'integer', minimum: 0 },
      outputTokens: { type: 'integer', minimum: 0 },
      agentId: { type: 'string' },
      apiKeyId: { type: 'string' },
      model: { type: 'string' },
      day: { type: 'string', format: 'date' },
    },
  },
  UsageQueryResponse: {
    type: 'object',
    required: ['usage'],
    additionalProperties: false,
    properties: {
      usage: {
        type: 'array',
        items: { $ref: '#/components/schemas/UsageAggregate' },
      },
    },
  },
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
      setup: jobSetup,
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
      setup: jobSetup,
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
      setup: jobSetup,
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
