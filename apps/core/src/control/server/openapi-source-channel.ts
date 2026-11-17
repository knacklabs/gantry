import { z } from 'zod';
import {
  RebuildSourceGenerationSchema,
  RebuildSourceGenerationResponseSchema,
  AppendSourceMessageRequestSchema,
  AppendSourceMessageResponseSchema,
  RequestSourceAnswerSchema,
  RequestSourceAnswerResponseSchema,
  SettleSourceHistorySchema,
  SettleExecutionAuthoritySchema,
  SourceAnswerExecutionProfileSchema,
} from '@gantry/contracts';
import { doc, ids } from './openapi-route-helpers.js';
export const sourceChannelRouteDocs = [
  doc(
    'post',
    '/v1/sessions/{sessionId}/source-generation/rebuild',
    'rebuildSourceGeneration',
    'Sessions',
    'Rebuild source generation',
    'Invalidates derived context and attempts while preserving canonical prior source history. Does not admit model work.',
    ['agents:admin'],
    { body: 'json', parameters: [ids.session], conflict: true },
  ),
  doc(
    'put',
    '/v1/agents/{agentId}/source-channel-profile',
    'configureSourceChannelProfile',
    'Agents',
    'Provision native source profile',
    'Pins the app agent allowed answer tools and native source capacity.',
    ['agents:admin'],
    { body: 'json', parameters: [ids.agent] },
  ),
  doc(
    'post',
    '/v1/sessions/{sessionId}/source-messages',
    'appendSourceMessage',
    'Sessions',
    'Persist source history',
    'Stores source history without admitting any model work.',
    ['sessions:write'],
    { body: 'json', parameters: [ids.session], conflict: true },
  ),
  doc(
    'post',
    '/v1/sessions/{sessionId}/answers',
    'requestSourceAnswer',
    'Sessions',
    'Answer a stored question',
    'Admits an explicit answer using an immutable source cutoff.',
    ['sessions:write'],
    { body: 'json', parameters: [ids.session], conflict: true },
  ),
  doc(
    'post',
    '/v1/sessions/{sessionId}/source-history/settle',
    'settleSourceHistory',
    'Sessions',
    'Settle source history',
    'Settles one durable bounded history request.',
    ['sessions:write'],
    { body: 'json', parameters: [ids.session], conflict: true },
  ),
  doc(
    'post',
    '/v1/sessions/{sessionId}/execution-authority/settle',
    'settleExecutionAuthority',
    'Sessions',
    'Settle current authority',
    'Settles current answer execution authority.',
    ['sessions:write'],
    { body: 'json', parameters: [ids.session], conflict: true },
  ),
];
const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'openapi-3.0' });
export const sourceChannelRequests = {
  rebuildSourceGeneration: json(RebuildSourceGenerationSchema),
  configureSourceChannelProfile: json(
    z
      .object({
        appId: z.string(),
        profile: SourceAnswerExecutionProfileSchema,
        concurrency: z.number().int().min(1).max(16),
      })
      .strict(),
  ),
  appendSourceMessage: json(AppendSourceMessageRequestSchema),
  requestSourceAnswer: json(RequestSourceAnswerSchema),
  settleSourceHistory: json(SettleSourceHistorySchema),
  settleExecutionAuthority: json(SettleExecutionAuthoritySchema),
};
const settled = json(
  z.object({ accepted: z.literal(true), replayed: z.boolean() }).strict(),
);
export const sourceChannelResponses = {
  rebuildSourceGeneration: json(RebuildSourceGenerationResponseSchema),
  configureSourceChannelProfile: json(
    z
      .object({
        profileHash: z.string(),
        effectiveConcurrency: z.number().int(),
      })
      .strict(),
  ),
  appendSourceMessage: json(AppendSourceMessageResponseSchema),
  requestSourceAnswer: json(RequestSourceAnswerResponseSchema),
  settleSourceHistory: settled,
  settleExecutionAuthority: settled,
};
