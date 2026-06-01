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

export const adminOpenApiSchemas: Record<string, JsonSchema> = {
  Provider: {
    type: 'object',
    required: ['id', 'displayName'],
    properties: {
      id: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      capabilities: metadata,
    },
  },
  ProviderListResponse: arrayEnvelope('providers', 'Provider'),
  ProviderConnection: {
    type: 'object',
    required: ['id', 'appId', 'providerId', 'label', 'status', 'enabled'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      providerId: { type: 'string' },
      label: { type: 'string' },
      status: { type: 'string' },
      enabled: { type: 'boolean' },
      config: metadata,
      runtimeSecretRefs: { type: 'array', items: metadata },
      externalRef: metadata,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  ProviderConnectionListResponse: arrayEnvelope(
    'providerConnections',
    'ProviderConnection',
  ),
  ProviderConnectionDeleteResponse: {
    type: 'object',
    required: ['deleted', 'providerConnection'],
    properties: {
      deleted: { type: 'boolean' },
      providerConnection: { $ref: '#/components/schemas/ProviderConnection' },
    },
  },
  ProviderConnectionRequest: {
    type: 'object',
    required: ['appId', 'providerId', 'label'],
    properties: {
      appId: { type: 'string' },
      providerId: { type: 'string' },
      label: { type: 'string' },
      config: metadata,
      runtimeSecretRefs: { type: 'array', items: metadata },
      externalRef: metadata,
      enabled: { type: 'boolean' },
    },
  },
  Conversation: {
    type: 'object',
    required: ['id', 'appId', 'providerConnectionId', 'kind'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      providerConnectionId: { type: 'string' },
      providerId: { type: 'string' },
      kind: { type: 'string' },
      displayName: { type: 'string' },
      externalRef: metadata,
      metadata,
    },
  },
  ConversationListResponse: arrayEnvelope('conversations', 'Conversation'),
  ConversationThread: {
    type: 'object',
    required: ['id', 'conversationId'],
    properties: {
      id: { type: 'string' },
      conversationId: { type: 'string' },
      displayName: { type: 'string' },
      externalRef: metadata,
      createdAt: isoDateTime,
    },
  },
  ConversationThreadListResponse: arrayEnvelope(
    'threads',
    'ConversationThread',
  ),
  ConversationMessageListResponse: {
    type: 'object',
    required: ['messages'],
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'conversationId', 'senderId', 'text', 'createdAt'],
          properties: {
            id: { type: 'string' },
            conversationId: { type: 'string' },
            threadId: { type: 'string' },
            senderId: { type: 'string' },
            senderName: { type: 'string' },
            text: { type: 'string' },
            createdAt: isoDateTime,
          },
        },
      },
    },
  },
  ConversationApproversResponse: {
    type: 'object',
    required: ['approvers'],
    properties: { approvers: stringArray },
  },
  ConversationApproversRequest: {
    type: 'object',
    required: ['userIds'],
    properties: { userIds: stringArray },
  },
  AgentConversationBinding: {
    type: 'object',
    required: ['agentId', 'conversationId', 'status'],
    properties: {
      agentId: { type: 'string' },
      conversationId: { type: 'string' },
      threadId: { type: 'string' },
      status: { type: 'string' },
      requiresTrigger: { type: 'boolean' },
      senderPolicy: metadata,
      triggerPolicy: metadata,
    },
  },
  AgentConversationBindingListResponse: arrayEnvelope(
    'bindings',
    'AgentConversationBinding',
  ),
  AgentConversationBindingRequest: {
    type: 'object',
    properties: {
      threadId: { type: 'string' },
      requiresTrigger: { type: 'boolean' },
      senderPolicy: metadata,
      triggerPolicy: metadata,
    },
  },
  AgentConversationBindingDeleteResponse: {
    type: 'object',
    required: ['disabled', 'binding'],
    properties: {
      disabled: { type: 'boolean' },
      binding: { $ref: '#/components/schemas/AgentConversationBinding' },
    },
  },
  GuidedActionType: {
    type: 'string',
    enum: [
      'connect_provider',
      'add_conversation_binding',
      'grant_access',
      'resume_job',
      'review_memory',
      'change_agent_model',
      'restart_runtime',
      'run_verification',
      'none',
    ],
  },
  GuidedActionRequest: {
    type: 'object',
    properties: {
      action: { $ref: '#/components/schemas/GuidedActionType' },
      label: { type: 'string' },
      params: {
        type: 'object',
        description:
          'Target identifiers for execution (e.g. { "jobId": "job_1" } for resume_job). String values only.',
        additionalProperties: { type: 'string' },
      },
    },
  },
  GuidedActionPreview: {
    type: 'object',
    required: [
      'action',
      'label',
      'effect',
      'requiresApproval',
      'writesSettings',
      'restartsRuntime',
    ],
    properties: {
      action: { $ref: '#/components/schemas/GuidedActionType' },
      label: { type: 'string' },
      effect: { type: 'string' },
      requiresApproval: { type: 'boolean' },
      writesSettings: { type: 'boolean' },
      restartsRuntime: { type: 'boolean' },
    },
  },
  GuidedActionResult: {
    oneOf: [
      {
        type: 'object',
        required: [
          'status',
          'changed',
          'savedTo',
          'restartRequired',
          'nextAction',
        ],
        properties: {
          status: { type: 'string', enum: ['done'] },
          changed: { type: 'string' },
          savedTo: {
            type: 'string',
            enum: ['settings.yaml', 'runtime state', 'access policy', 'none'],
          },
          restartRequired: { type: 'boolean' },
          nextAction: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['status', 'cause', 'recover'],
        properties: {
          status: { type: 'string', enum: ['failed'] },
          cause: { type: 'string' },
          recover: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['status', 'instruction'],
        properties: {
          status: { type: 'string', enum: ['manual'] },
          instruction: { type: 'string' },
        },
      },
    ],
  },
};
