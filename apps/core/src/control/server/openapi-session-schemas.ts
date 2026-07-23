import type { JsonSchema } from './openapi-route-helpers.js';

const isoDateTime = { type: 'string', format: 'date-time' };
const metadata = { type: 'object', additionalProperties: true };
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

export const openApiSessionSchemas: Record<string, JsonSchema> = {
  SessionEnsureRequest: {
    type: 'object',
    required: ['conversationId'],
    properties: {
      appId: { type: 'string', description: 'Optional API key app assertion.' },
      agentId: {
        type: 'string',
        description:
          'Optional agent id to bind the session to that agent workspace.',
      },
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
  SessionInteractionDecision: {
    type: 'string',
    enum: ['allow_once', 'allow_future', 'deny'],
    description:
      'Permission decision. Exactly three options exist; timed grants are not supported.',
  },
  SessionPendingInteraction: {
    type: 'object',
    required: [
      'id',
      'kind',
      'createdAt',
      'expiresAt',
      'runId',
      'toolName',
      'summary',
      'questions',
      'options',
    ],
    properties: {
      id: {
        type: 'string',
        description: 'Interaction id to use in the respond route.',
      },
      kind: { type: 'string', enum: ['permission', 'question'] },
      createdAt: isoDateTime,
      expiresAt: isoDateTime,
      runId: { type: ['string', 'null'] },
      toolName: { type: ['string', 'null'] },
      summary: {
        type: ['string', 'null'],
        description: 'Redacted command preview when available.',
      },
      questions: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description: 'Question texts for question interactions.',
      },
      options: {
        type: 'array',
        items: { $ref: '#/components/schemas/SessionInteractionDecision' },
        description:
          'Decisions available for this interaction. Empty for question interactions, which cannot be answered via this API.',
      },
    },
  },
  SessionInteractionListResponse: {
    type: 'object',
    required: ['interactions'],
    properties: {
      interactions: {
        type: 'array',
        items: { $ref: '#/components/schemas/SessionPendingInteraction' },
      },
    },
  },
  SessionInteractionRespondRequest: {
    type: 'object',
    required: ['decision'],
    properties: {
      decision: { $ref: '#/components/schemas/SessionInteractionDecision' },
    },
  },
  SessionInteractionRespondResponse: {
    type: 'object',
    required: ['status', 'interactionId', 'decision', 'decidedBy'],
    properties: {
      status: { type: 'string', enum: ['resolved'] },
      interactionId: { type: 'string' },
      decision: { $ref: '#/components/schemas/SessionInteractionDecision' },
      decidedBy: {
        type: 'string',
        description:
          'Approver identity recorded on the decision (api-key:<kid>).',
      },
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
