import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const setupHealthSchema = z.object({
  status: z.literal('ok'),
  processRole: z.string(),
  transport: z.object({ kind: z.enum(['tcp', 'unix']) }),
  features: z.object({
    sessions: z.boolean(),
    jobs: z.boolean(),
    events: z.boolean(),
    webhooks: z.boolean(),
  }),
});

export type SetupHealth = z.infer<typeof setupHealthSchema>;

export function checkSetupHealth(transport: RuntimeApiTransport) {
  return transport.request({
    path: '/health',
    schema: setupHealthSchema,
  });
}
