import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const providerSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  runtimeSecretKeys: z.array(z.string()).optional(),
  status: z.enum(['available', 'unavailable', 'disabled']),
});

const providerAccountSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  providerId: z.string(),
  label: z.string(),
  status: z.enum(['active', 'inactive', 'disabled', 'archived']),
});

const providersResponseSchema = z.object({
  providers: z.array(providerSchema),
});

export type SetupProvider = z.infer<typeof providerSchema>;

export function loadSetupProviders(transport: RuntimeApiTransport) {
  return transport.request({
    path: '/providers',
    schema: providersResponseSchema,
  });
}

export function createSetupProviderAccount(
  transport: RuntimeApiTransport,
  input: {
    appId: string;
    agentId: string;
    providerId: string;
    label: string;
    runtimeSecretRefs?: Record<string, string>;
  },
) {
  return transport.request({
    path: '/provider-accounts',
    method: 'POST',
    body: { ...input, enabled: true },
    schema: providerAccountSchema,
  });
}
