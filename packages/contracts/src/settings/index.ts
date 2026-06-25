import { z } from 'zod';

import {
  AgentPersonaSchema,
  AgentRelationshipModeSchema,
} from '../agents/index.js';
import { AgentHarnessSchema } from '../contract-primitives.js';

const EgressDenylistPatternSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\.+$/g, '').toLowerCase())
  .pipe(
    z
      .string()
      .min(1)
      .regex(
        /^(?:\*|\*\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:\*|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i,
        'Must be a hostname glob such as api.example.com or *.example.com',
      ),
  );

export const RuntimeSettingsConfiguredAgentBindingSchema = z
  .object({
    jid: z.string().trim().min(1),
    provider: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    trigger: z.string().trim().min(1),
    addedAt: z.string().trim().min(1),
    requiresTrigger: z.boolean(),
    model: z.string().optional(),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentSourceRefSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1),
    version: z.string().trim().min(1).optional(),
    kind: z.string().trim().min(1).optional(),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentSourcesSchema = z
  .object({
    skills: z.array(RuntimeSettingsConfiguredAgentSourceRefSchema),
    mcpServers: z.array(RuntimeSettingsConfiguredAgentSourceRefSchema),
    tools: z.array(RuntimeSettingsConfiguredAgentSourceRefSchema),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentCapabilitySchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentAccessSchema = z
  .object({
    preset: z.enum(['full', 'locked']),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentSchema = z
  .object({
    name: z.string().trim().min(1),
    folder: z.string().trim().min(1),
    persona: AgentPersonaSchema.optional(),
    relationshipMode: AgentRelationshipModeSchema.optional(),
    model: z.string().optional(),
    agentHarness: AgentHarnessSchema.optional(),
    oneTimeJobDefaultModel: z.string().optional(),
    recurringJobDefaultModel: z.string().optional(),
    bindings: z.record(z.string(), RuntimeSettingsConfiguredAgentBindingSchema),
    sources: RuntimeSettingsConfiguredAgentSourcesSchema,
    capabilities: z.array(RuntimeSettingsConfiguredAgentCapabilitySchema),
    access: RuntimeSettingsConfiguredAgentAccessSchema.optional(),
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
    memoryScope: z.enum(['conversation', 'user', 'agent']),
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
        agentHarness: AgentHarnessSchema,
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
            maxMessageBacklog: z.number().int().nonnegative(),
            maxTaskBacklog: z.number().int().nonnegative(),
            maxRetries: z.number().int().nonnegative(),
            baseRetryMs: z.number().int().nonnegative(),
            drainDeadlineMs: z.number().int().positive(),
          })
          .strict(),
        sandbox: z
          .object({
            provider: z.union([
              z.literal('direct'),
              z.literal('sandbox_runtime'),
            ]),
            resourceLimits: z
              .object({
                cpuSeconds: z.number().int().nonnegative(),
                memoryMb: z.number().int().nonnegative(),
                maxProcesses: z.number().int().nonnegative(),
              })
              .strict(),
          })
          .strict(),
        artifactStore: z
          .object({
            driver: z.union([z.literal('local'), z.literal('s3')]),
            bucket: z.string().min(1).optional(),
            region: z.string().min(1).optional(),
            endpoint: z.string().min(1).optional(),
            forcePathStyle: z.boolean().optional(),
          })
          .strict(),
        deploymentMode: z.union([z.literal('workstation'), z.literal('fleet')]),
      })
      .strict(),
    browser: z
      .object({
        usage: z
          .object({
            enabled: z.boolean(),
            mode: z.enum(['audit', 'enforce']),
            windowMs: z.number().int().positive(),
            maxActionsPerWindow: z.number().int().positive(),
            maxConcurrentPerSite: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    permissions: z
      .object({
        yoloMode: z
          .object({
            enabled: z.boolean(),
            denylist: z.array(z.string().trim().min(1)),
            denylistPaths: z.array(z.string().trim().min(1)),
          })
          .strict(),
        egress: z
          .object({
            denylist: z.array(EgressDenylistPatternSchema),
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

/**
 * The typed JSON settings document carried by the desired-state control API/SDK
 * and stored as `settings_revisions` jsonb. It is the full settings document in
 * its native (snake_case) object form — YAML is only the human file format for
 * the workstation file and CLI `--file` edge and never appears on the wire.
 * Authoritative document-path-level validation runs server-side through the
 * runtime settings parser; this contract names the wire shape for SDK consumers.
 */
export const SettingsDocumentSchema = z.record(z.string(), z.unknown());
export type SettingsDocument = z.infer<typeof SettingsDocumentSchema>;
