import { z } from 'zod';

import { AgentPersonaSchema } from '../agents/index.js';

export const RuntimeSettingsConfiguredAgentDmAccessSchema = z
  .object({
    provider: z.string().trim().min(1),
    userIds: z.array(z.string().trim().min(1)),
    adminUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentBindingSchema = z
  .object({
    jid: z.string().trim().min(1),
    provider: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    trigger: z.string().trim().min(1),
    addedAt: z.string().trim().min(1),
    requiresTrigger: z.boolean(),
    isMain: z.boolean(),
    model: z.string().optional(),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentCapabilitiesSchema = z
  .object({
    toolIds: z.array(z.string().trim().min(1)),
    skillIds: z.array(z.string().trim().min(1)),
    mcpServerIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentSchema = z
  .object({
    name: z.string().trim().min(1),
    folder: z.string().trim().min(1),
    persona: AgentPersonaSchema.optional(),
    model: z.string().optional(),
    oneTimeJobDefaultModel: z.string().optional(),
    recurringJobDefaultModel: z.string().optional(),
    bindings: z.record(z.string(), RuntimeSettingsConfiguredAgentBindingSchema),
    dmAccess: z.array(RuntimeSettingsConfiguredAgentDmAccessSchema),
    capabilities: RuntimeSettingsConfiguredAgentCapabilitiesSchema,
  })
  .strict();

export const RuntimeSettingsProviderSchema = z
  .object({
    enabled: z.boolean(),
    defaultConnection: z.string().optional(),
  })
  .strict();

export const RuntimeSettingsProviderConnectionSchema = z
  .object({
    provider: z.string().trim().min(1),
    label: z.string(),
    runtimeSecretRefs: z.record(z.string(), z.string()),
  })
  .strict();

export const RuntimeSettingsConversationSchema = z
  .object({
    providerConnection: z.string().trim().min(1),
    externalId: z.string().trim().min(1),
    kind: z.enum([
      'dm',
      'direct',
      'group',
      'channel',
      'chat',
      'service',
      'web',
    ]),
    displayName: z.string(),
    senderPolicy: z
      .object({
        allow: z.union([z.literal('*'), z.array(z.string().trim().min(1))]),
        mode: z.enum(['trigger', 'drop']),
      })
      .strict(),
    controlApprovers: z.array(z.string().trim().min(1)),
  })
  .strict();

export const RuntimeSettingsBindingSchema = z
  .object({
    agent: z.string().trim().min(1),
    conversation: z.string().trim().min(1),
    trigger: z.string().trim().min(1),
    addedAt: z.string().trim().min(1),
    requiresTrigger: z.boolean(),
    isMain: z.boolean(),
    memoryScope: z.enum(['conversation', 'thread', 'user', 'agent']),
    model: z.string().optional(),
  })
  .strict();

export const RuntimeSettingsPublicSchema = z
  .object({
    desiredState: z
      .object({
        authoritative: z.boolean(),
      })
      .strict(),
    agent: z
      .object({
        name: z.string(),
        defaultModel: z.string(),
        oneTimeJobDefaultModel: z.string(),
        recurringJobDefaultModel: z.string(),
      })
      .strict(),
    agents: z.record(z.string(), RuntimeSettingsConfiguredAgentSchema),
    providers: z.record(z.string(), RuntimeSettingsProviderSchema),
    providerConnections: z.record(
      z.string(),
      RuntimeSettingsProviderConnectionSchema,
    ),
    conversations: z.record(z.string(), RuntimeSettingsConversationSchema),
    bindings: z.record(z.string(), RuntimeSettingsBindingSchema),
    memory: z
      .object({
        enabled: z.boolean(),
        dreaming: z
          .object({
            enabled: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    runtime: z
      .object({
        queue: z
          .object({
            maxMessageRuns: z.number().int().positive(),
            maxJobRuns: z.number().int().positive(),
            maxRetries: z.number().int().nonnegative(),
            baseRetryMs: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type RuntimeSettingsPublic = z.infer<typeof RuntimeSettingsPublicSchema>;

export const RuntimeSettingsResponseSchema = z
  .object({
    settings: RuntimeSettingsPublicSchema,
  })
  .strict();
export type RuntimeSettingsResponse = z.infer<
  typeof RuntimeSettingsResponseSchema
>;
