import type { JsonSchema } from './openapi-route-helpers.js';

const isoDateTime = { type: 'string', format: 'date-time' };
const metadata = { type: 'object', additionalProperties: true };
const runtimeSecretRefs = {
  type: 'object',
  additionalProperties: { type: 'string' },
};
const conversationInstallRouteConfig = {
  type: 'object',
  properties: {
    trigger: { type: 'string' },
    requiresTrigger: { type: 'boolean' },
    agentConfig: metadata,
  },
};
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
      runtimeSecretKeys: stringArray,
    },
  },
  ProviderListResponse: arrayEnvelope('providers', 'Provider'),
  ProviderAccount: {
    type: 'object',
    required: ['id', 'appId', 'agentId', 'providerId', 'label', 'status'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      agentId: { type: 'string' },
      providerId: { type: 'string' },
      label: { type: 'string' },
      status: { type: 'string' },
      config: metadata,
      runtimeSecretRefs,
      externalRef: metadata,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  ProviderAccountListResponse: arrayEnvelope(
    'providerAccounts',
    'ProviderAccount',
  ),
  ProviderAccountDeleteResponse: {
    type: 'object',
    required: ['deleted', 'providerAccount'],
    properties: {
      deleted: { type: 'boolean' },
      providerAccount: { $ref: '#/components/schemas/ProviderAccount' },
    },
  },
  ProviderAccountRequest: {
    type: 'object',
    required: ['appId', 'agentId', 'providerId', 'label'],
    properties: {
      appId: { type: 'string' },
      agentId: { type: 'string' },
      providerId: { type: 'string' },
      label: { type: 'string' },
      config: metadata,
      runtimeSecretRefs,
      externalRef: metadata,
      enabled: { type: 'boolean' },
    },
  },
  ProviderAccountUpdateRequest: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      status: {
        type: 'string',
        enum: ['active', 'inactive', 'disabled', 'archived'],
      },
      config: metadata,
      runtimeSecretRefs,
      externalRef: { anyOf: [metadata, { type: 'null' }] },
      enabled: { type: 'boolean' },
      metadata,
    },
  },
  Conversation: {
    type: 'object',
    required: ['id', 'appId', 'providerAccountId', 'kind'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      providerAccountId: { type: 'string' },
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
  ConversationInstall: {
    type: 'object',
    required: ['agentId', 'providerAccountId', 'conversationId', 'status'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      agentId: { type: 'string' },
      providerAccountId: { type: 'string' },
      conversationId: { type: 'string' },
      threadId: { type: 'string' },
      displayName: { type: 'string' },
      status: { type: 'string' },
      memoryScope: { type: 'string' },
      memorySubject: metadata,
      routeConfig: conversationInstallRouteConfig,
      workspaceSnapshotId: { type: 'string' },
      permissionPolicyIds: stringArray,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  ConversationInstallListResponse: arrayEnvelope(
    'conversationInstalls',
    'ConversationInstall',
  ),
  ConversationInstallRequest: {
    type: 'object',
    properties: {
      providerAccountId: { type: 'string' },
      threadId: { type: 'string' },
      displayName: { type: 'string' },
      memoryScope: { type: 'string' },
      memorySubject: metadata,
      routeConfig: conversationInstallRouteConfig,
      workspaceSnapshotId: { type: 'string' },
      permissionPolicyIds: stringArray,
      status: { type: 'string' },
    },
  },
  ConversationInstallDeleteResponse: {
    type: 'object',
    required: ['disabled', 'conversationInstall'],
    properties: {
      disabled: { type: 'boolean' },
      conversationInstall: {
        $ref: '#/components/schemas/ConversationInstall',
      },
    },
  },
  GuidedActionType: {
    type: 'string',
    enum: [
      'connect_provider',
      'add_conversation_install',
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
