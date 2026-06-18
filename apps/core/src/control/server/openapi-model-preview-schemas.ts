import { AgentHarnessSchema } from '@gantry/contracts';

import type { JsonSchema } from './openapi-route-helpers.js';

const stringArray = { type: 'array', items: { type: 'string' } };

const agentHarnessEnum = [...AgentHarnessSchema.options];

export const agentHarnessProp: JsonSchema = {
  type: 'string',
  enum: agentHarnessEnum,
  description:
    'Public agent harness. auto preserves provider-derived behavior; explicit values are user intent validated against the selected model.',
};

export const modelPreviewSchemas: Record<string, JsonSchema> = {
  ModelPreviewRequest: {
    type: 'object',
    required: ['target'],
    properties: {
      target: { type: 'string', enum: ['chat', 'jobs', 'job', 'agent', 'memory'] }, // prettier-ignore
      jobId: { type: 'string' },
      agentId: { type: 'string', description: 'Agent folder for "agent".' },
      modelAlias: { type: 'string', description: 'Alias for "agent".' },
      conversationJid: {
        type: 'string',
        description:
          'Optional chat preview scope for session /model overrides.',
      },
      workspaceKey: {
        type: 'string',
        description:
          'Optional workspace key preview scope for session /model overrides.',
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
      target: { type: 'string', enum: ['chat', 'jobs', 'job', 'agent', 'memory'] }, // prettier-ignore
      jobId: { type: 'string' },
      agentId: { type: 'string' },
      scope: { type: 'string' },
      kind: { type: 'string', enum: ['one-time', 'recurring'] },
      task: {
        type: 'string',
        enum: ['extractor', 'dreaming', 'consolidation'],
      },
      agentHarness: { type: 'string', enum: agentHarnessEnum },
      credentialProfile: { type: 'string' },
      executionProviderId: { type: 'string' },
      incompatible: { type: 'string' },
      selection: { $ref: '#/components/schemas/ModelDefaultSlot' },
      why: stringArray,
    },
  },
};
