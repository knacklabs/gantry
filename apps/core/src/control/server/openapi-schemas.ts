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
  AgentCapabilitiesRequest: {
    type: 'object',
    required: ['selectedToolIds', 'selectedSkillIds', 'selectedMcpServerIds'],
    properties: {
      selectedToolIds: stringArray,
      selectedSkillIds: stringArray,
      selectedMcpServerIds: stringArray,
    },
  },
  AgentCapabilitiesResponse: {
    allOf: [
      { $ref: '#/components/schemas/AgentCapabilitiesRequest' },
      {
        type: 'object',
        required: ['agentId', 'toolAccess', 'updatedAt'],
        properties: {
          agentId: { type: 'string' },
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
    required: ['id', 'displayName', 'aliases', 'provider'],
    properties: {
      id: { type: 'string', example: 'opus' },
      modelProfileId: { type: 'string' },
      displayName: { type: 'string' },
      aliases: stringArray,
      recommendedAlias: { type: 'string' },
      provider: { type: 'string' },
      contextWindowTokens: { type: 'integer' },
      maxOutputTokens: { type: 'integer' },
      supportsTools: { type: 'boolean' },
      supportsThinking: { type: 'boolean' },
      experimental: { type: 'boolean' },
    },
  },
  ModelListResponse: arrayEnvelope('models', 'Model'),
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
