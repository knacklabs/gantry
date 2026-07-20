import type { JsonSchema } from './openapi-route-helpers.js';
import { contractOpenApiSchemas } from './openapi-contract-schemas.js';
import { modelCredentialSchemas } from './openapi-model-credential-schemas.js';

const isoDateTime = { type: 'string', format: 'date-time' };
const metadata = { type: 'object', additionalProperties: true };
const stringArray = { type: 'array', items: { type: 'string' } };
const agentHarnessProp: JsonSchema = {
  $ref: '#/components/schemas/AgentHarness',
  description:
    'Public agent harness. auto preserves provider-derived behavior; explicit values are user intent validated against the selected model.',
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

export const openApiSchemas: Record<string, JsonSchema> = {
  ...contractOpenApiSchemas,
  Agent: {
    type: 'object',
    required: ['id', 'appId', 'name', 'status', 'agentHarness', 'createdAt', 'updatedAt'], // prettier-ignore
    properties: {
      id: { type: 'string', example: 'agent:main' },
      appId: { type: 'string', example: 'default' },
      name: { type: 'string', example: 'Support Agent' },
      status: { type: 'string', enum: ['active', 'disabled'] },
      agentHarness: agentHarnessProp,
      currentConfigVersionId: { type: ['string', 'null'] },
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  AgentListResponse: arrayEnvelope('agents', 'Agent'),
  AgentCreateRequest: {
    type: 'object',
    required: ['appId', 'name'],
    additionalProperties: false,
    properties: {
      appId: { type: 'string', example: 'default' },
      name: { type: 'string', minLength: 1 },
      agentHarness: agentHarnessProp,
    },
  },
  AgentUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['active', 'disabled'] },
      agentHarness: agentHarnessProp,
    },
  },
  ReplaceAgentDelegatesRequest: {
    type: 'object',
    required: ['delegates'],
    additionalProperties: false,
    properties: {
      delegates: {
        type: 'array',
        maxItems: 100,
        items: { type: 'string', minLength: 1, maxLength: 160 },
      },
      expectedRevision: { type: 'integer', minimum: 0 },
    },
  },
  AgentDelegateResolved: {
    type: 'object',
    required: ['ref', 'agentId', 'toolName', 'displayName', 'persona'],
    additionalProperties: false,
    properties: {
      ref: { type: 'string' },
      agentId: { type: 'string' },
      toolName: { type: 'string' },
      displayName: { type: 'string' },
      persona: {
        type: 'string',
        enum: [
          'developer',
          'generalist',
          'sales',
          'marketing',
          'operations',
          'research',
        ],
      },
    },
  },
  AgentDelegatesResponse: {
    type: 'object',
    required: ['agentId', 'revision', 'delegates', 'resolved'],
    additionalProperties: false,
    properties: {
      agentId: { type: 'string' },
      revision: { type: 'integer', minimum: 0 },
      delegates: stringArray,
      resolved: {
        type: 'array',
        items: { $ref: '#/components/schemas/AgentDelegateResolved' },
      },
    },
  },
  SettingsRevisionResponse: {
    type: 'object',
    required: ['revision'],
    additionalProperties: false,
    properties: { revision: { type: 'integer', minimum: 0 } },
  },
  AgentAdminSummaryResponse: {
    type: 'object',
    required: ['agent', 'boundConversations'],
    properties: {
      agent: { $ref: '#/components/schemas/Agent' },
      capabilities: { $ref: '#/components/schemas/AgentAccessResponse' },
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
  AgentMcpSourceSelection: {
    type: 'object',
    required: ['id'],
    properties: {
      name: { type: 'string' },
      id: { type: 'string' },
      version: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      tools: { type: 'array', items: { type: 'string' } },
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
        items: { $ref: '#/components/schemas/AgentMcpSourceSelection' },
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
  AgentAccessRequest: {
    type: 'object',
    required: ['sources'],
    properties: {
      sources: { $ref: '#/components/schemas/AgentSources' },
      selections: {
        type: 'array',
        items: { $ref: '#/components/schemas/CapabilitySelection' },
      },
    },
  },
  AgentAccessResponse: {
    type: 'object',
    required: ['agentId', 'sources', 'selections', 'toolAccess', 'updatedAt'],
    properties: {
      agentId: { type: 'string' },
      sources: { $ref: '#/components/schemas/AgentSources' },
      selections: {
        type: 'array',
        items: { $ref: '#/components/schemas/CapabilitySelection' },
      },
      toolAccess: metadata,
      summary: metadata,
      updatedAt: isoDateTime,
    },
  },
  HealthResponse: {
    type: 'object',
    required: ['status', 'processRole', 'transport', 'features'],
    properties: {
      status: { type: 'string', example: 'ok' },
      processRole: {
        type: 'string',
        enum: ['all', 'control', 'live-worker', 'job-worker'],
      },
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
  ReadOnlySettingsPatchRequest: metadata,
  SessionEnsureRequest: {
    type: 'object',
    required: ['conversationId'],
    properties: {
      appId: { type: 'string', description: 'Optional API key app assertion.' },
      conversationId: { type: 'string' },
      title: { type: 'string' },
      responseMode: {
        type: 'string',
        enum: ['sse', 'webhook', 'both', 'none'],
      },
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
  SendSessionMessageRequest: {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      senderId: { type: 'string', default: 'sdk' },
      senderName: { type: 'string', default: 'SDK' },
      threadId: { type: 'string' },
      correlationId: { type: 'string' },
      responseMode: {
        type: 'string',
        enum: ['sse', 'webhook', 'both', 'none'],
      },
      webhookId: { type: 'string' },
      response_schema: {
        type: 'object',
        description:
          'JSON Schema object requesting strict structured output for this inline turn.',
      },
      effort: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      thinking: {
        oneOf: [
          { type: 'string', enum: ['off', 'on'] },
          {
            type: 'object',
            required: ['mode'],
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['off'] },
            },
          },
          {
            type: 'object',
            required: ['mode'],
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['on'] },
              budget_tokens: { type: 'integer', minimum: 1 },
            },
          },
        ],
      },
      max_output_tokens: { type: 'integer', minimum: 1 },
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
