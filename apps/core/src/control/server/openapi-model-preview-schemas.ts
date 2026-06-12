import { AgentEngineSchema } from '@gantry/contracts';

import type { JsonSchema } from './openapi-route-helpers.js';

const stringArray = { type: 'array', items: { type: 'string' } };

// Engine enum is sourced from the contracts schema so the provider literals stay
// in the approved contracts module and never appear in this adapter file.
const agentEngineEnum = [...AgentEngineSchema.options];

// Read is the effective engine; write rewrites settings.yaml and reconciles,
// rejecting incompatible model/engine pairs. Raw executionProviderId stays
// internal/diagnostic.
export const agentEngineProp: JsonSchema = {
  type: 'string',
  enum: agentEngineEnum,
  description:
    'Public agent engine. Read is the effective engine; write rewrites settings.yaml and reconciles, rejecting incompatible model/engine pairs. Raw executionProviderId stays internal.',
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
      agentEngine: { type: 'string', enum: agentEngineEnum },
      agentEngineLabel: { type: 'string' },
      credentialProfile: { type: 'string' },
      // executionProviderId is the internal diagnostic; incompatible carries the
      // locked plan copy when the model/engine pairing is unsupported.
      executionProviderId: { type: 'string' },
      incompatible: { type: 'string' },
      selection: { $ref: '#/components/schemas/ModelDefaultSlot' },
      why: stringArray,
    },
  },
};
