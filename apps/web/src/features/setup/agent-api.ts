import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const createdAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

export type CreatedSetupAgent = z.infer<typeof createdAgentSchema>;

export function createSetupAgent(
  transport: RuntimeApiTransport,
  input: { appId: string; name: string },
) {
  return transport.request({
    path: '/agents',
    method: 'POST',
    body: input,
    schema: createdAgentSchema,
  });
}
