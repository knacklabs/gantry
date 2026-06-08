import type { JsonSchema } from './openapi-route-helpers.js';
import { listModelPresets } from '../../shared/model-catalog.js';
import { modelCredentialSchemas } from './openapi-model-credential-schemas.js';

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

export const openApiSchemas: Record<string, JsonSchema> = {
  Agent: {
    type: 'object',
    required: ['id', 'appId', 'name', 'status', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', example: 'agent:main' },
      appId: { type: 'string', example: 'default' },
      name: { type: 'string', example: 'Support Agent' },
      status: { type: 'string', enum: ['active', 'disabled'] },
      currentConfigVersionId: { type: ['string', 'null'] },
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  AgentListResponse: arrayEnvelope('agents', 'Agent'),
  AgentCreateRequest: {
    type: 'object',
    required: ['appId', 'name'],
    properties: {
      appId: { type: 'string', example: 'default' },
      name: { type: 'string', minLength: 1 },
    },
  },
  AgentUpdateRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['active', 'disabled'] },
    },
  },
  AgentAdminSummaryResponse: {
    type: 'object',
    required: ['agent', 'boundConversations'],
    properties: {
      agent: { $ref: '#/components/schemas/Agent' },
      capabilities: { $ref: '#/components/schemas/AgentCapabilitiesResponse' },
      boundConversations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            conversationId: { type: 'string' },
            provider: { type: 'string' },
            kind: { type: 'string' },
            displayName: { type: 'string' },
            approverUserIds: stringArray,
            requiresTrigger: { type: 'boolean' },
          },
        },
      },
    },
  },
  CapabilityCatalogResponse: {
    type: 'object',
    required: ['tools', 'skills', 'mcpServers'],
    properties: {
      tools: { type: 'array', items: metadata },
      skills: { type: 'array', items: metadata },
      mcpServers: { type: 'array', items: metadata },
    },
  },
  InventoryResponse: {
    type: 'object',
    required: ['inventory'],
    properties: {
      inventory: { $ref: '#/components/schemas/CapabilityCatalogResponse' },
    },
  },
  CapabilitySelection: {
    type: 'object',
    required: ['id', 'version'],
    properties: {
      id: { type: 'string' },
      version: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    },
  },
  CapabilityManifest: {
    type: 'object',
    required: ['id', 'version', 'displayName', 'category', 'risk'],
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      version: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      displayName: { type: 'string' },
      category: { type: 'string' },
      risk: { type: 'string' },
      can: { type: 'string' },
      cannot: { type: 'string' },
      source: { type: 'string' },
      bindings: { type: 'array', items: metadata },
      inputs: metadata,
      secrets: { type: 'array', items: metadata },
      preflight: metadata,
      sandbox: metadata,
      protectedPaths: stringArray,
      redaction: metadata,
      approval: metadata,
      audit: metadata,
    },
  },
  CapabilityListResponse: arrayEnvelope('capabilities', 'CapabilityManifest'),
  ...modelCredentialSchemas,
  AgentSourceSelection: {
    type: 'object',
    required: ['id'],
    properties: {
      name: { type: 'string' },
      id: { type: 'string' },
      version: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    },
  },
  AgentToolSourceSelection: {
    type: 'object',
    required: ['id', 'kind'],
    properties: {
      id: { type: 'string' },
      kind: {
        type: 'string',
        enum: ['builtin', 'adapter', 'local_cli'],
      },
      version: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    },
  },
  AgentSources: {
    type: 'object',
    required: ['skills', 'mcpServers', 'tools'],
    properties: {
      skills: {
        type: 'array',
        items: { $ref: '#/components/schemas/AgentSourceSelection' },
      },
      mcpServers: {
        type: 'array',
        items: { $ref: '#/components/schemas/AgentSourceSelection' },
      },
      tools: {
        type: 'array',
        items: { $ref: '#/components/schemas/AgentToolSourceSelection' },
      },
    },
  },
  AgentSourcesRequest: {
    type: 'object',
    required: ['sources'],
    properties: {
      sources: { $ref: '#/components/schemas/AgentSources' },
    },
  },
  AgentSourcesResponse: {
    type: 'object',
    required: ['agentId', 'sources', 'updatedAt'],
    properties: {
      agentId: { type: 'string' },
      sources: { $ref: '#/components/schemas/AgentSources' },
      updatedAt: isoDateTime,
    },
  },
  AgentCapabilitiesRequest: {
    type: 'object',
    required: ['capabilities'],
    properties: {
      capabilities: {
        type: 'array',
        items: { $ref: '#/components/schemas/CapabilitySelection' },
      },
    },
  },
  AgentCapabilitiesResponse: {
    allOf: [
      { $ref: '#/components/schemas/AgentCapabilitiesRequest' },
      {
        type: 'object',
        required: ['agentId', 'sources', 'toolAccess', 'updatedAt'],
        properties: {
          agentId: { type: 'string' },
          sources: { $ref: '#/components/schemas/AgentSources' },
          toolAccess: metadata,
          updatedAt: isoDateTime,
        },
      },
    ],
  },
  HealthResponse: {
    type: 'object',
    required: ['status', 'transport', 'features'],
    properties: {
      status: { type: 'string', example: 'ok' },
      transport: metadata,
      features: metadata,
    },
  },
  DoctorResponse: {
    type: 'object',
    required: ['status', 'checks'],
    properties: {
      status: { type: 'string', example: 'ok' },
      checks: { type: 'array', items: metadata },
    },
  },
  Model: {
    type: 'object',
    required: [
      'id',
      'displayName',
      'aliases',
      'recommendedAlias',
      'responseFamily',
      'executionProviderId',
      'credentialProfileRef',
      'modelRoute',
      'capabilities',
      'supportedWorkloads',
      'cacheSupport',
    ],
    properties: {
      id: { type: 'string' },
      displayName: { type: 'string' },
      aliases: stringArray,
      recommendedAlias: { type: 'string' },
      responseFamily: { type: 'string' },
      executionProviderId: { type: 'string' },
      credentialProfileRef: { type: 'string' },
      modelRoute: {
        type: 'object',
        required: ['id', 'label', 'metadata'],
        properties: {
          id: {
            type: 'string',
            enum: listModelPresets().map((preset) => preset.id),
          },
          label: { type: 'string' },
          metadata: {
            type: 'object',
            required: ['providerModelId'],
            additionalProperties: false,
            properties: {
              providerModelId: { type: 'string' },
            },
          },
        },
      },
      capabilities: {
        type: 'object',
        required: [
          'streaming',
          'toolUse',
          'mcpProjection',
          'browserProjection',
          'sandboxProjection',
          'providerSessionResume',
          'thinking',
          'tokenAccounting',
          'cacheAccounting',
          'structuredOutput',
        ],
        properties: {
          streaming: { type: 'boolean' },
          toolUse: { type: 'boolean' },
          mcpProjection: { type: 'boolean' },
          browserProjection: { type: 'boolean' },
          sandboxProjection: { type: 'boolean' },
          providerSessionResume: { type: 'boolean' },
          thinking: { type: 'boolean' },
          tokenAccounting: { type: 'boolean' },
          cacheAccounting: { type: 'boolean' },
          structuredOutput: { type: 'boolean' },
        },
      },
      supportedWorkloads: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'chat',
            'one_time_job',
            'recurring_job',
            'memory_extractor',
            'memory_dreaming',
            'memory_consolidation',
          ],
        },
      },
      contextWindowTokens: { type: 'integer' },
      maxOutputTokens: { type: 'integer' },
      cacheMode: { type: 'string' },
      cacheTokenFields: stringArray,
      cacheSupport: {
        type: 'object',
        required: [
          'providerId',
          'providerLabel',
          'cacheProvider',
          'statusLabel',
          'prompt',
          'response',
          'tokenFields',
        ],
        properties: {
          providerId: { type: 'string' },
          providerLabel: { type: 'string' },
          cacheProvider: { type: 'string' },
          statusLabel: { type: 'string' },
          prompt: {
            type: 'object',
            required: [
              'mode',
              'automatic',
              'requestControl',
              'ttlOptions',
              'minimumTokenThresholds',
              'usageFields',
              'supported',
              'accounted',
            ],
            properties: {
              mode: { type: 'string' },
              automatic: { type: 'boolean' },
              requestControl: { type: 'string' },
              ttlOptions: stringArray,
              minimumTokenThresholds: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['modelFamily', 'tokens'],
                  properties: {
                    modelFamily: { type: 'string' },
                    tokens: { type: 'integer' },
                  },
                },
              },
              usageFields: metadata,
              supported: { type: 'boolean' },
              accounted: { type: 'boolean' },
            },
          },
          response: {
            type: 'object',
            required: [
              'mode',
              'enabledByDefault',
              'requestControl',
              'requestHeaders',
              'responseHeaders',
              'usageBehavior',
              'available',
            ],
            properties: {
              mode: { type: 'string' },
              enabledByDefault: { type: 'boolean' },
              requestControl: { type: 'string' },
              requestHeaders: stringArray,
              responseHeaders: stringArray,
              usageBehavior: { type: 'string' },
              available: { type: 'boolean' },
            },
          },
          tokenFields: stringArray,
        },
      },
      supportsTools: { type: 'boolean' },
      supportsThinking: { type: 'boolean' },
      source: metadata,
      experimental: { type: 'boolean' },
    },
  },
  ModelListResponse: arrayEnvelope('models', 'Model'),
  ModelDefaultSlot: {
    type: 'object',
    required: [
      'configuredAlias',
      'effectiveAlias',
      'source',
      'inherited',
      'workload',
      'model',
    ],
    properties: {
      configuredAlias: { type: ['string', 'null'] },
      effectiveAlias: { type: ['string', 'null'] },
      source: { type: 'string' },
      inherited: { type: 'boolean' },
      workload: { type: 'string' },
      model: {
        oneOf: [{ $ref: '#/components/schemas/Model' }, { type: 'null' }],
      },
    },
  },
  ModelDefaultsResponse: {
    type: 'object',
    required: ['preset', 'chat', 'jobs', 'memory', 'defaults'],
    properties: {
      preset: {
        oneOf: [
          {
            type: 'object',
            required: ['id', 'label'],
            properties: {
              id: {
                type: 'string',
                enum: listModelPresets().map((preset) => preset.id),
              },
              label: { type: 'string' },
            },
          },
          { type: 'null' },
        ],
      },
      chat: { $ref: '#/components/schemas/ModelDefaultSlot' },
      jobs: {
        type: 'object',
        required: ['oneTime', 'recurring'],
        properties: {
          oneTime: { $ref: '#/components/schemas/ModelDefaultSlot' },
          recurring: { $ref: '#/components/schemas/ModelDefaultSlot' },
        },
      },
      memory: {
        type: 'object',
        required: ['mode', 'extractor', 'dreaming', 'consolidation'],
        properties: {
          mode: { type: 'string', enum: ['preset-managed'] },
          extractor: { $ref: '#/components/schemas/ModelDefaultSlot' },
          dreaming: { $ref: '#/components/schemas/ModelDefaultSlot' },
          consolidation: { $ref: '#/components/schemas/ModelDefaultSlot' },
        },
      },
      defaults: {
        type: 'object',
        required: [
          'chat',
          'oneTime',
          'recurring',
          'memoryExtractor',
          'memoryDreaming',
          'memoryConsolidation',
        ],
        properties: {
          chat: { $ref: '#/components/schemas/ModelDefaultSlot' },
          oneTime: { $ref: '#/components/schemas/ModelDefaultSlot' },
          recurring: { $ref: '#/components/schemas/ModelDefaultSlot' },
          memoryExtractor: {
            $ref: '#/components/schemas/ModelDefaultSlot',
          },
          memoryDreaming: {
            $ref: '#/components/schemas/ModelDefaultSlot',
          },
          memoryConsolidation: {
            $ref: '#/components/schemas/ModelDefaultSlot',
          },
        },
      },
    },
  },
  ModelDefaultsPatchRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      preset: {
        type: 'string',
        enum: listModelPresets().map((preset) => preset.id),
      },
      chat: { type: ['string', 'null'] },
      jobs: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Model alias, "inherit", or null.',
      },
      oneTime: { type: ['string', 'null'] },
      recurring: { type: ['string', 'null'] },
      memory: {
        oneOf: [
          { type: 'string', enum: ['reset', 'preset-managed'] },
          { type: 'null' },
        ],
        description: 'Use null, "reset", or "preset-managed".',
      },
    },
  },
  ModelPreviewRequest: {
    type: 'object',
    required: ['target'],
    properties: {
      target: { type: 'string', enum: ['chat', 'jobs', 'job', 'memory'] },
      jobId: { type: 'string' },
      conversationJid: {
        type: 'string',
        description:
          'Optional chat preview scope for session /model overrides.',
      },
      groupScope: {
        type: 'string',
        description:
          'Optional group folder/name preview scope for session /model overrides.',
      },
      kind: { type: 'string', enum: ['one-time', 'recurring'] },
      task: {
        type: 'string',
        enum: ['extractor', 'dreaming', 'consolidation'],
      },
    },
  },
  ModelPreviewResponse: {
    type: 'object',
    required: ['target', 'selection', 'why'],
    properties: {
      target: { type: 'string', enum: ['chat', 'jobs', 'job', 'memory'] },
      jobId: { type: 'string' },
      scope: { type: 'string' },
      kind: { type: 'string', enum: ['one-time', 'recurring'] },
      task: {
        type: 'string',
        enum: ['extractor', 'dreaming', 'consolidation'],
      },
      selection: { $ref: '#/components/schemas/ModelDefaultSlot' },
      why: stringArray,
    },
  },
  SettingsResponse: envelope('settings', metadata),
  ReadOnlySettingsPatchRequest: metadata,
  SessionEnsureRequest: {
    type: 'object',
    required: ['conversationId'],
    properties: {
      appId: { type: 'string', description: 'Optional API key app assertion.' },
      conversationId: { type: 'string' },
      title: { type: 'string' },
      responseMode: { type: 'string', enum: ['sse', 'webhook'] },
      webhookId: { type: 'string' },
    },
  },
  SessionEnsureResponse: {
    type: 'object',
    required: ['sessionId', 'appId', 'conversationId', 'chatJid'],
    properties: {
      sessionId: { type: 'string' },
      appId: { type: 'string' },
      conversationId: { type: 'string' },
      chatJid: { type: 'string' },
    },
  },
  SessionDetails: metadata,
  SessionMessage: {
    type: 'object',
    required: ['messageId', 'sessionId', 'senderId', 'message', 'createdAt'],
    properties: {
      messageId: { type: 'string' },
      sessionId: { type: 'string' },
      senderId: { type: 'string' },
      senderName: { type: 'string' },
      message: { type: 'string' },
      threadId: { type: 'string' },
      createdAt: isoDateTime,
    },
  },
  SessionMessageListResponse: arrayEnvelope('messages', 'SessionMessage'),
  SendSessionMessageRequest: {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      senderId: { type: 'string', default: 'sdk' },
      senderName: { type: 'string', default: 'SDK' },
      threadId: { type: 'string' },
      correlationId: { type: 'string' },
      responseMode: { type: 'string', enum: ['sse', 'webhook'] },
      webhookId: { type: 'string' },
    },
  },
  SendSessionMessageResponse: {
    type: 'object',
    required: ['accepted', 'messageId', 'acceptedEventId'],
    properties: {
      accepted: { type: 'boolean' },
      messageId: { type: 'string' },
      acceptedEventId: { type: 'integer' },
    },
  },
  RuntimeEvent: {
    type: 'object',
    required: ['eventId', 'eventType', 'createdAt'],
    properties: {
      eventId: { type: 'integer' },
      eventType: { type: 'string' },
      payload: metadata,
      createdAt: isoDateTime,
    },
  },
  RuntimeEventListResponse: arrayEnvelope('events', 'RuntimeEvent'),
  WaitEventResponse: {
    allOf: [
      { $ref: '#/components/schemas/RuntimeEvent' },
      {
        type: 'object',
        properties: { afterEventId: { type: 'integer' } },
      },
    ],
  },
  Run: {
    type: 'object',
    required: ['run_id', 'job_id', 'status'],
    properties: {
      run_id: { type: 'string' },
      job_id: { type: 'string' },
      status: { type: 'string' },
      started_at: isoDateTime,
      completed_at: { oneOf: [isoDateTime, { type: 'null' }] },
    },
  },
  RunListResponse: arrayEnvelope('runs', 'Run'),
};
