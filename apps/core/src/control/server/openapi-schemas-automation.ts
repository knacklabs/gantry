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
const consoleMetricUsageProperties = {
  requestCount: { type: 'integer', minimum: 0 },
  inputTokens: { type: 'integer', minimum: 0 },
  outputTokens: { type: 'integer', minimum: 0 },
  cacheReadTokens: { type: 'integer', minimum: 0 },
  cacheWriteTokens: { type: 'integer', minimum: 0 },
  estimatedCostUsd: { type: 'number', minimum: 0 },
};

export const automationOpenApiSchemas: Record<string, JsonSchema> = {
  ActivityRun: {
    type: 'object',
    required: [
      'id',
      'agentId',
      'cause',
      'status',
      'createdAt',
      'startedAt',
      'endedAt',
      'durationMs',
      'resultSummary',
      'errorSummary',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      agentId: { type: 'string' },
      cause: {
        type: 'string',
        enum: ['message', 'job', 'control', 'manual', 'system'],
      },
      status: {
        type: 'string',
        enum: [
          'queued',
          'running',
          'completed',
          'failed',
          'canceled',
          'timeout',
        ],
      },
      createdAt: isoDateTime,
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      endedAt: { type: ['string', 'null'], format: 'date-time' },
      durationMs: { type: ['integer', 'null'], minimum: 0 },
      resultSummary: { type: ['string', 'null'] },
      errorSummary: { type: ['string', 'null'] },
    },
  },
  ActivityTask: {
    type: 'object',
    required: [
      'id',
      'agentId',
      'targetAgentId',
      'kind',
      'status',
      'summary',
      'outputSummary',
      'errorSummary',
      'currentPhase',
      'lastProgress',
      'lastToolSummary',
      'blocker',
      'createdAt',
      'updatedAt',
      'startedAt',
      'terminalAt',
      'durationMs',
      'children',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      agentId: { type: 'string' },
      targetAgentId: { type: ['string', 'null'] },
      kind: {
        type: 'string',
        enum: [
          'async_command',
          'delegated_agent',
          'mcp_tool_call',
          'session_compaction',
        ],
      },
      status: {
        type: 'string',
        enum: [
          'queued',
          'running',
          'needs_attention',
          'completed',
          'failed',
          'cancelled',
          'timed_out',
        ],
      },
      summary: { type: ['string', 'null'] },
      outputSummary: { type: ['string', 'null'] },
      errorSummary: { type: ['string', 'null'] },
      currentPhase: { type: ['string', 'null'] },
      lastProgress: { type: ['string', 'null'] },
      lastToolSummary: { type: ['string', 'null'] },
      blocker: { type: ['string', 'null'] },
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      terminalAt: { type: ['string', 'null'], format: 'date-time' },
      durationMs: { type: ['integer', 'null'], minimum: 0 },
      children: {
        type: 'array',
        items: { $ref: '#/components/schemas/ActivityTask' },
      },
    },
  },
  ActivityListResponse: {
    type: 'object',
    required: ['runs'],
    additionalProperties: false,
    properties: {
      runs: {
        type: 'array',
        maxItems: 50,
        items: { $ref: '#/components/schemas/ActivityRun' },
      },
    },
  },
  ActivityDetailResponse: {
    type: 'object',
    required: ['run', 'tasks', 'taskTotal', 'truncated'],
    additionalProperties: false,
    properties: {
      run: { $ref: '#/components/schemas/ActivityRun' },
      tasks: {
        type: 'array',
        items: { $ref: '#/components/schemas/ActivityTask' },
      },
      taskTotal: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' },
    },
  },
  ActivityInvalidation: {
    type: 'object',
    required: ['eventId', 'type', 'createdAt'],
    additionalProperties: false,
    properties: {
      eventId: { type: 'integer', minimum: 0 },
      type: { type: 'string' },
      createdAt: isoDateTime,
    },
  },
  ActivityInvalidationListResponse: {
    type: 'object',
    required: ['events'],
    additionalProperties: false,
    properties: {
      events: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/ActivityInvalidation' },
      },
    },
  },
  ConsoleMetricUsage: {
    type: 'object',
    required: ['requestCount', 'inputTokens', 'outputTokens'],
    additionalProperties: false,
    properties: consoleMetricUsageProperties,
  },
  ConsoleMetricUsageBucket: {
    type: 'object',
    required: ['start', 'requestCount', 'inputTokens', 'outputTokens'],
    additionalProperties: false,
    properties: { start: isoDateTime, ...consoleMetricUsageProperties },
  },
  ConsoleMetricModel: {
    type: 'object',
    required: ['model', 'requestCount', 'inputTokens', 'outputTokens'],
    additionalProperties: false,
    properties: {
      model: { type: 'string' },
      ...consoleMetricUsageProperties,
    },
  },
  ConsoleMetricsResponse: {
    type: 'object',
    required: ['range', 'from', 'to', 'bucket', 'usage', 'runs'],
    additionalProperties: false,
    properties: {
      range: { type: 'string', enum: ['24h', '7d', '30d'] },
      from: isoDateTime,
      to: isoDateTime,
      bucket: { type: 'string', enum: ['hour', 'day'] },
      usage: {
        type: 'object',
        required: ['totals', 'buckets', 'models'],
        additionalProperties: false,
        properties: {
          totals: { $ref: '#/components/schemas/ConsoleMetricUsage' },
          buckets: {
            type: 'array',
            maxItems: 31,
            items: { $ref: '#/components/schemas/ConsoleMetricUsageBucket' },
          },
          models: {
            type: 'array',
            maxItems: 6,
            items: { $ref: '#/components/schemas/ConsoleMetricModel' },
          },
        },
      },
      runs: {
        type: 'object',
        required: ['total', 'statuses'],
        additionalProperties: false,
        properties: {
          total: { type: 'integer', minimum: 0 },
          statuses: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              required: ['status', 'count'],
              additionalProperties: false,
              properties: {
                status: {
                  type: 'string',
                  enum: ['completed', 'failed', 'canceled'],
                },
                count: { type: 'integer', minimum: 0 },
              },
            },
          },
          p95DurationMs: { type: 'number', minimum: 0 },
        },
      },
    },
  },
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
