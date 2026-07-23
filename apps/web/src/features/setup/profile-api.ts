import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const profileFileSchema = z.object({
  agentId: z.string(),
  kind: z.literal('soul'),
  path: z.string(),
  version: z.number().int().nonnegative(),
  contentHash: z.string(),
  content: z.string(),
});

export type SetupProfileFile = z.infer<typeof profileFileSchema>;

export function loadSetupProfile(
  transport: RuntimeApiTransport,
  agentId: string,
) {
  return transport.request({
    path: `/agents/${encodeURIComponent(agentId)}/profile-files/soul`,
    schema: profileFileSchema,
  });
}

export function saveSetupProfile(
  transport: RuntimeApiTransport,
  input: { agentId: string; content: string; expectedVersion?: number },
) {
  return transport.request({
    path: `/agents/${encodeURIComponent(input.agentId)}/profile-files/soul`,
    method: 'PUT',
    body: {
      content: input.content,
      expectedVersion: input.expectedVersion,
    },
    schema: profileFileSchema,
  });
}
