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

export const extensionOpenApiSchemas: Record<string, JsonSchema> = {
  MemoryItem: {
    type: 'object',
    required: ['id', 'appId', 'kind', 'content', 'createdAt'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      agentId: { type: 'string' },
      userId: { type: 'string' },
      groupId: { type: 'string' },
      channelId: { type: 'string' },
      threadId: { type: 'string' },
      kind: {
        type: 'string',
        enum: ['preference', 'decision', 'fact', 'correction', 'constraint'],
      },
      content: { type: 'string' },
      metadata,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  MemoryListResponse: arrayEnvelope('memories', 'MemoryItem'),
  MemorySearchResponse: arrayEnvelope('results', 'MemoryItem'),
  MemoryItemResponse: envelope('memory', {
    $ref: '#/components/schemas/MemoryItem',
  }),
  MemorySaveRequest: {
    type: 'object',
    required: ['kind', 'content'],
    properties: {
      appId: { type: 'string' },
      agentId: { type: 'string' },
      userId: { type: 'string' },
      groupId: { type: 'string' },
      channelId: { type: 'string' },
      threadId: { type: 'string' },
      kind: {
        type: 'string',
        enum: ['preference', 'decision', 'fact', 'correction', 'constraint'],
      },
      content: { type: 'string' },
      metadata,
    },
  },
  MemorySearchRequest: {
    type: 'object',
    required: ['query'],
    properties: {
      appId: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
      agentId: { type: 'string' },
      userId: { type: 'string' },
      groupId: { type: 'string' },
    },
  },
  MemoryDreamingResponse: envelope('run', metadata),
  MemoryDreamingStatusResponse: envelope('runs', {
    type: 'array',
    items: metadata,
  }),
  Skill: {
    type: 'object',
    required: ['id', 'appId', 'name', 'status'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      name: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string' },
      requiredEnvVars: { type: 'array', items: { type: 'string' } },
      actionPermissions: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'id',
            'capabilityId',
            'displayName',
            'risk',
            'can',
            'cannot',
            'requiredEnvVars',
            'commandTemplates',
          ],
          properties: {
            id: { type: 'string' },
            capabilityId: { type: 'string' },
            displayName: { type: 'string' },
            risk: { type: 'string', enum: ['read', 'write', 'admin'] },
            can: { type: 'string' },
            cannot: { type: 'string' },
            requiredEnvVars: { type: 'array', items: { type: 'string' } },
            commandTemplates: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  SkillDraftListResponse: arrayEnvelope('drafts', 'Skill'),
  SkillResponse: envelope('skill', { $ref: '#/components/schemas/Skill' }),
  SkillDraftResponse: envelope('draft', { $ref: '#/components/schemas/Skill' }),
  SkillDraftDecisionRequest: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      approvedBy: { type: 'string' },
      rejectedBy: { type: 'string' },
      reason: { type: 'string' },
    },
  },
  SkillFilesResponse: {
    type: 'object',
    required: ['skill', 'files'],
    properties: {
      skill: { $ref: '#/components/schemas/Skill' },
      files: { type: 'array', items: metadata },
    },
  },
  SkillFileResponse: envelope('file', metadata),
  AgentSkillBindingResponse: envelope('binding', metadata),
  AgentSkillBindingRequest: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      required: { type: 'boolean' },
    },
  },
  AgentSkillBindingListResponse: envelope('bindings', {
    type: 'array',
    items: metadata,
  }),
  McpServer: {
    type: 'object',
    required: ['id', 'appId', 'name', 'status'],
    properties: {
      id: { type: 'string' },
      appId: { type: 'string' },
      name: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string' },
      transportConfig: metadata,
      allowedToolPatterns: stringArray,
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    },
  },
  McpServerPageResponse: {
    type: 'object',
    properties: {
      servers: {
        type: 'array',
        items: { $ref: '#/components/schemas/McpServer' },
      },
      drafts: {
        type: 'array',
        items: { $ref: '#/components/schemas/McpServer' },
      },
      nextCursor: { type: ['string', 'null'] },
    },
  },
  McpServerRequest: {
    type: 'object',
    required: ['name', 'config'],
    properties: {
      appId: { type: 'string' },
      name: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      config: metadata,
      allowedToolPatterns: stringArray,
      autoApproveToolPatterns: stringArray,
      credentialRefs: { type: 'array', items: metadata },
      sandboxProfileId: { type: 'string' },
      riskClass: { type: 'string' },
    },
  },
  McpServerResponse: envelope('server', {
    $ref: '#/components/schemas/McpServer',
  }),
  McpServerTestRequest: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      testedBy: { type: 'string' },
    },
  },
  McpServerTestResponse: {
    type: 'object',
    required: ['ok', 'message', 'server'],
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
      server: { $ref: '#/components/schemas/McpServer' },
    },
  },
  McpServerDraftResponse: {
    type: 'object',
    required: ['server', 'version'],
    properties: {
      server: { $ref: '#/components/schemas/McpServer' },
      version: metadata,
    },
  },
  AgentMcpServerBindingResponse: envelope('binding', metadata),
  AgentMcpServerBindingRequest: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      versionId: { type: 'string' },
      required: { type: 'boolean' },
      permissionPolicyIds: stringArray,
    },
  },
  AgentMcpServerBindingListResponse: envelope('bindings', {
    type: 'array',
    items: metadata,
  }),
};
