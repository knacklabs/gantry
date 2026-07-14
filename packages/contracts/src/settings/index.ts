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
    providerAccountId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional(),
    trigger: z.string().trim().min(1),
    addedAt: z.string().trim().min(1),
    requiresTrigger: z.boolean(),
    model: z.string().optional(),
    permissionMode: z.enum(['ask', 'auto']).optional(),
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

const RuntimeSettingsConfiguredToolRuleWhenSchema = z
  .object({
    arg: z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, 'Must be a dot path'),
    matches: z
      .string()
      .trim()
      .min(1)
      .refine((value) => {
        try {
          new RegExp(value);
          return true;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return false;
        }
      }, 'Must be a valid regular expression'),
  })
  .strict();

export const RuntimeSettingsConfiguredToolRuleSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        tool: z.string().trim().min(1),
        when: RuntimeSettingsConfiguredToolRuleWhenSchema.optional(),
        action: z.literal('block'),
        reason: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        tool: z.string().trim().min(1),
        action: z.literal('require_prior'),
        prior: z.string().trim().min(1),
        reason: z.string().trim().min(1),
      })
      .strict(),
  ],
);
export type RuntimeSettingsConfiguredToolRule = z.infer<
  typeof RuntimeSettingsConfiguredToolRuleSchema
>;

export const RuntimeSettingsConfiguredAgentSchema = z
  .object({
    name: z.string().trim().min(1),
    folder: z.string().trim().min(1),
    persona: AgentPersonaSchema.optional(),
    relationshipMode: AgentRelationshipModeSchema.optional(),
    model: z.string().optional(),
    agentHarness: AgentHarnessSchema.optional(),
    permissionMode: z.enum(['ask', 'auto']).optional(),
    runtime: z.enum(['worker', 'inline']).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxRunTokens: z.number().int().positive().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    thinking: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('off') }).strict(),
        z
          .object({
            mode: z.literal('on'),
            budgetTokens: z.number().int().positive().optional(),
          })
          .strict(),
      ])
      .optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    oneTimeJobDefaultModel: z.string().optional(),
    recurringJobDefaultModel: z.string().optional(),
    toolRules: z.array(RuntimeSettingsConfiguredToolRuleSchema).optional(),
    bindings: z.record(z.string(), RuntimeSettingsConfiguredAgentBindingSchema),
    sources: RuntimeSettingsConfiguredAgentSourcesSchema,
    capabilities: z.array(RuntimeSettingsConfiguredAgentCapabilitySchema),
    access: RuntimeSettingsConfiguredAgentAccessSchema.optional(),
  })
  .strict();

export const RuntimeSettingsProviderSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const RuntimeSettingsProviderAccountSchema = z
  .object({
    agentId: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    label: z.string(),
    status: z.enum(['active', 'disabled']).optional(),
    runtimeSecretRefs: z.record(z.string(), z.string()),
    externalIdentityRef: z.record(z.string(), z.string()).optional(),
    config: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const RuntimeSettingsConversationSchema = z
  .object({
    providerAccount: z.string().trim().min(1),
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
    brainHarvest: z.boolean(),
    senderPolicy: z
      .object({
        allow: z.union([z.literal('*'), z.array(z.string().trim().min(1))]),
        mode: z.enum(['trigger', 'drop']),
      })
      .strict(),
    controlApprovers: z.array(z.string().trim().min(1)),
    installedAgents: z.record(
      z.string(),
      z
        .object({
          agentId: z.string().trim().min(1),
          providerAccountId: z.string().trim().min(1),
          threadId: z.string().trim().min(1).optional(),
          status: z.enum(['active', 'disabled']),
          addedAt: z.string().trim().min(1),
          memoryScope: z.enum(['conversation', 'user', 'agent', 'app']),
          trigger: z.string().optional(),
          requiresTrigger: z.boolean().optional(),
          model: z.string().optional(),
          permissionMode: z.enum(['ask', 'auto']).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const RuntimeSettingsBindingSchema = z
  .object({
    agent: z.string().trim().min(1),
    providerAccountId: z.string().trim().min(1).optional(),
    installKey: z.string().trim().min(1).optional(),
    conversation: z.string().trim().min(1),
    threadId: z.string().trim().min(1).optional(),
    trigger: z.string().trim().min(1),
    addedAt: z.string().trim().min(1),
    requiresTrigger: z.boolean(),
    memoryScope: z.enum(['conversation', 'user', 'agent', 'app']),
    model: z.string().optional(),
    permissionMode: z.enum(['ask', 'auto']).optional(),
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
    providerAccounts: z.record(
      z.string(),
      RuntimeSettingsProviderAccountSchema,
    ),
    conversations: z.record(z.string(), RuntimeSettingsConversationSchema),
    bindings: z.record(z.string(), RuntimeSettingsBindingSchema),
    conversationInstalls: z.record(
      z.string(),
      z
        .object({
          agentId: z.string().trim().min(1),
          providerAccountId: z.string().trim().min(1),
          conversationId: z.string().trim().min(1),
          threadId: z.string().trim().min(1).optional(),
          status: z.enum(['active', 'disabled']),
          addedAt: z.string().trim().min(1),
          memoryScope: z.enum(['conversation', 'user', 'agent', 'app']),
          trigger: z.string().optional(),
          requiresTrigger: z.boolean().optional(),
          model: z.string().optional(),
          permissionMode: z.enum(['ask', 'auto']).optional(),
        })
        .strict(),
    ),
    modelAliases: z.record(z.string(), z.unknown()).optional(),
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
        autoMode: z
          .object({
            model: z.string().trim().min(1).optional(),
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
