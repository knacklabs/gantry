import type { JsonSchema } from './openapi-route-helpers.js';

const isoDateTime = { type: 'string', format: 'date-time' } as const;
const count = { type: 'integer', minimum: 0 } as const;
const stringMap = {
  type: 'object',
  additionalProperties: { type: 'string' },
} as const;

const nextAction = {
  type: 'object',
  required: ['kind', 'label'],
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: [
        'runtime_blocked',
        'missing_model_credential',
        'missing_provider_connection',
        'missing_conversation_install',
        'missing_access_approval',
        'blocked_job',
        'memory_review_setup',
        'none',
      ],
    },
    label: { type: 'string' },
    params: stringMap,
  },
} as const;

const agentSession = {
  type: 'object',
  required: ['id', 'appId', 'agentId', 'status', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    appId: { type: 'string' },
    agentId: { type: 'string' },
    conversationId: { type: 'string' },
    threadId: { type: 'string' },
    jobId: { type: 'string' },
    userId: { type: 'string' },
    status: { type: 'string', enum: ['active', 'reset', 'archived'] },
    model: { type: 'string' },
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    resetAt: isoDateTime,
  },
} as const;

const externalRef = (kind: string) => ({
  type: 'object',
  required: ['kind', 'value'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [kind] },
    value: { type: 'string' },
  },
});

const messageTrust = {
  type: 'string',
  enum: ['trusted', 'untrusted', 'system'],
} as const;

const sessionRuntimeEventProperties = {
  eventId: { type: 'integer' },
  eventType: { type: 'string' },
  sessionId: { type: ['string', 'null'] },
  threadId: { type: ['string', 'null'] },
  correlationId: { type: ['string', 'null'] },
  createdAt: isoDateTime,
  payload: {},
} as const;

const sessionRuntimeEventRequired = [
  'eventId',
  'eventType',
  'sessionId',
  'threadId',
  'correlationId',
  'createdAt',
  'payload',
];

export const controlOpenApiSchemas: Record<string, JsonSchema> = {
  ControlStatusResponse: {
    type: 'object',
    required: [
      'title',
      'runtime',
      'workspaceKey',
      'agents',
      'conversations',
      'jobs',
      'access',
      'memory',
      'providers',
      'nextAction',
      'agentDetails',
    ],
    additionalProperties: false,
    properties: {
      title: { type: 'string', enum: ['Gantry'] },
      runtime: { type: 'string', enum: ['Ready', 'Needs setup', 'Blocked'] },
      workspaceKey: { type: 'string' },
      agents: {
        type: 'object',
        required: ['ready', 'total'],
        additionalProperties: false,
        properties: { ready: count, total: count },
      },
      conversations: {
        type: 'object',
        required: ['ready', 'total'],
        additionalProperties: false,
        properties: { ready: count, total: count },
      },
      jobs: {
        type: 'object',
        required: ['ready', 'needsAction', 'blocked'],
        additionalProperties: false,
        properties: { ready: count, needsAction: count, blocked: count },
      },
      access: {
        type: 'object',
        required: ['approved', 'needsApproval'],
        additionalProperties: false,
        properties: { approved: count, needsApproval: count },
      },
      memory: {
        type: 'string',
        enum: ['Ready', 'Needs setup', 'Needs review', 'Disabled'],
      },
      providers: {
        type: 'object',
        required: ['ready', 'needsConnection', 'blocked'],
        additionalProperties: false,
        properties: { ready: count, needsConnection: count, blocked: count },
      },
      nextAction,
      agentDetails: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'id',
            'name',
            'modelAlias',
            'workspaceKey',
            'conversations',
            'approvedCapabilities',
            'activeJobs',
            'memory',
            'nextAction',
          ],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            modelAlias: { type: 'string' },
            workspaceKey: { type: 'string' },
            conversations: count,
            approvedCapabilities: count,
            activeJobs: count,
            memory: {
              type: 'string',
              enum: ['Ready', 'Needs setup', 'Needs review', 'Disabled'],
            },
            nextAction,
          },
        },
      },
    },
  },
  SessionDetails: {
    type: 'object',
    required: ['session', 'providerSession'],
    additionalProperties: false,
    properties: {
      session: agentSession,
      providerSession: {
        oneOf: [
          {
            type: 'object',
            required: [
              'provider',
              'status',
              'hasProviderResume',
              'createdAt',
              'updatedAt',
            ],
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              status: {
                type: 'string',
                enum: [
                  'active',
                  'expired',
                  'reset',
                  'maintenance_compact',
                  'ready',
                ],
              },
              hasProviderResume: { type: 'boolean' },
              createdAt: isoDateTime,
              updatedAt: isoDateTime,
            },
          },
          { type: 'null' },
        ],
      },
    },
  },
  SessionMessage: {
    type: 'object',
    required: [
      'id',
      'appId',
      'conversationId',
      'direction',
      'trust',
      'createdAt',
      'parts',
      'attachments',
    ],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      conversationId: { type: 'string' },
      threadId: { type: 'string' },
      externalRef: externalRef('message'),
      direction: {
        type: 'string',
        enum: ['inbound', 'outbound', 'system', 'tool'],
      },
      senderUserId: { type: 'string' },
      senderDisplayName: { type: 'string' },
      trust: messageTrust,
      createdAt: isoDateTime,
      receivedAt: isoDateTime,
      deliveryStatus: {
        type: 'string',
        enum: ['pending', 'sent', 'failed', 'partially_sent'],
      },
      deliveredAt: isoDateTime,
      deliveryError: { type: 'string' },
      parts: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              required: ['kind', 'text'],
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['text'] },
                text: { type: 'string' },
              },
            },
            {
              type: 'object',
              required: ['kind', 'markdown'],
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['markdown'] },
                markdown: { type: 'string' },
              },
            },
            {
              type: 'object',
              required: ['kind', 'code'],
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['code'] },
                language: { type: 'string' },
                code: { type: 'string' },
              },
            },
            {
              type: 'object',
              required: ['kind', 'value'],
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['structured'] },
                value: {},
              },
            },
            {
              type: 'object',
              required: ['kind', 'toolId', 'value'],
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['tool_result'] },
                toolId: { type: 'string' },
                value: {},
              },
            },
            {
              type: 'object',
              required: ['kind', 'reason'],
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['redacted'] },
                reason: { type: 'string' },
              },
            },
          ],
        },
      },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'messageId', 'kind', 'trust'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            messageId: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['image', 'file', 'audio', 'video', 'other'],
            },
            contentType: { type: 'string' },
            sizeBytes: { type: 'integer', minimum: 0 },
            externalRef: externalRef('message_attachment'),
            storageRef: { type: 'string' },
            trust: messageTrust,
          },
        },
      },
    },
  },
  SessionMessageListResponse: {
    type: 'object',
    required: ['messages'],
    additionalProperties: false,
    properties: {
      messages: {
        type: 'array',
        items: { $ref: '#/components/schemas/SessionMessage' },
      },
    },
  },
  SessionRuntimeEvent: {
    type: 'object',
    required: sessionRuntimeEventRequired,
    additionalProperties: false,
    properties: sessionRuntimeEventProperties,
  },
  SessionRuntimeEventListResponse: {
    type: 'object',
    required: ['events'],
    additionalProperties: false,
    properties: {
      events: {
        type: 'array',
        items: { $ref: '#/components/schemas/SessionRuntimeEvent' },
      },
    },
  },
  SessionWaitEventResponse: {
    type: 'object',
    required: [...sessionRuntimeEventRequired, 'afterEventId'],
    additionalProperties: false,
    properties: {
      ...sessionRuntimeEventProperties,
      afterEventId: { type: 'integer' },
    },
  },
  DiscoverProviderConversationsRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      includeArchived: { type: 'boolean' },
      providerMetadata: { type: 'object', additionalProperties: true },
    },
  },
  DisableMcpServerRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      appId: { type: 'string' },
      disabledBy: { type: 'string' },
      reason: { type: 'string' },
    },
  },
  BrainImportRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      appId: { type: 'string' },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['slug', 'markdown'],
          additionalProperties: false,
          properties: {
            slug: { type: 'string', minLength: 1 },
            markdown: { type: 'string' },
            title: { type: 'string' },
            sourceRef: { type: ['string', 'null'] },
            authorId: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
  BrainImportResponse: {
    type: 'object',
    required: ['imported', 'created', 'updated'],
    additionalProperties: false,
    properties: { imported: count, created: count, updated: count },
  },
  BrainStatusResponse: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: {
      status: {
        type: 'object',
        required: [
          'pages',
          'channelPages',
          'dreamPages',
          'entities',
          'edges',
          'dreamDecisions',
          'lastDreamCursor',
          'readyEmbeddings',
          'pendingEmbeddings',
          'harvestEnabledConversations',
        ],
        additionalProperties: false,
        properties: {
          pages: count,
          channelPages: count,
          dreamPages: count,
          entities: count,
          edges: count,
          dreamDecisions: count,
          lastDreamCursor: { type: ['string', 'null'] },
          readyEmbeddings: count,
          pendingEmbeddings: count,
          harvestEnabledConversations: count,
        },
      },
    },
  },
};
