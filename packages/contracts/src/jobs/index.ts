import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { AgentPersonaSchema } from '../agents/index.js';

export const JobScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('once'), runAt: IsoDateTimeSchema }),
  z.object({ type: z.literal('cron'), value: z.string().min(1) }),
  z.object({ type: z.literal('interval'), value: z.string().min(1) }),
]);
export type JobSchedule = z.infer<typeof JobScheduleSchema>;

export const JobStatusSchema = z.enum([
  'active',
  'paused',
  'running',
  'completed',
  'failed',
  'dead_lettered',
  'archived',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobModelSourceSchema = z.union([
  z.literal('explicit'),
  z.literal('system default'),
  z.literal('settings.yaml agents.<agent>.model'),
  z.literal('settings.yaml agents.<agent>.one_time_job_default_model'),
  z.literal('settings.yaml agents.<agent>.recurring_job_default_model'),
  z.literal('settings.yaml agent.default_model'),
  z.literal('settings.yaml agent.one_time_job_default_model'),
  z.literal('settings.yaml agent.recurring_job_default_model'),
  z.literal('group.agentConfig.model'),
]);
export type JobModelSource = z.infer<typeof JobModelSourceSchema>;

export const JobModelPreviewSchema = z
  .object({
    displayName: z.string(),
    responseFamily: z.string(),
    modelRoute: z
      .object({
        id: z.string(),
        label: z.string(),
      })
      .strict(),
    contextWindowTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().nonnegative(),
    cachePolicy: z.string(),
  })
  .strict();
export type JobModelPreview = z.infer<typeof JobModelPreviewSchema>;

export const JobModelSelectionSchema = z
  .object({
    alias: z.string().nullable(),
    source: z.string(),
    explicit: z.boolean(),
  })
  .strict();
export type JobModelSelection = z.infer<typeof JobModelSelectionSchema>;

export const JobRuntimeContextPreviewSchema = z.object({
  executionContext: z
    .object({
      conversationJid: z.string(),
      threadId: z.string().nullable(),
      groupScope: z.string(),
      sessionId: z.string().nullable().optional(),
    })
    .strict(),
  notificationRoutes: z
    .array(
      z
        .object({
          conversationJid: z.string(),
          threadId: z.string().nullable(),
          label: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  browserProfileLabel: z.string(),
  browserProfileName: z.string(),
  persona: AgentPersonaSchema,
});
export type JobRuntimeContextPreview = z.infer<
  typeof JobRuntimeContextPreviewSchema
>;

export const JobExecutionContextSchema = z
  .object({
    conversationJid: z.string(),
    threadId: z.string().nullable(),
    groupScope: z.string(),
    sessionId: z.string().nullable(),
  })
  .strict();
export type JobExecutionContext = z.infer<typeof JobExecutionContextSchema>;

const JobRequestExecutionContextSchema = JobExecutionContextSchema.extend({
  sessionId: z.string(),
}).strict();

export const JobNotificationRouteSchema = z
  .object({
    conversationJid: z.string(),
    threadId: z.string().nullable(),
    label: z.string().min(1),
  })
  .strict();
export type JobNotificationRoute = z.infer<typeof JobNotificationRouteSchema>;

export const JobTargetSchema = z.object({
  sessionId: z.string().optional(),
  bindingId: z.string().optional(),
  conversationId: z.string().optional(),
  threadId: z.string().optional(),
  userId: z.string().optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type JobTarget = z.infer<typeof JobTargetSchema>;

export const JobResolvedTargetSchema = z.object({
  appId: z.string(),
  agentId: z.string(),
  groupScope: z.string(),
  conversationJids: z.array(z.string()),
  threadId: z.string().nullable(),
});

export const JobRecentRunErrorSchema = z.object({
  runId: z.string(),
  status: z.string(),
  errorSummary: z.string(),
  endedAt: IsoDateTimeSchema.nullable(),
});

export const JobStalenessSchema = z.enum(['missed_window']);

export const JobHealthSchema = z
  .object({
    state: z.enum([
      'ready',
      'missing_capability',
      'broker_unreachable',
      'credential_unknown',
      'browser_login_may_be_required',
      'mcp_missing_credential',
      'running',
      'completed',
      'failed',
      'needs_permission',
      'timed_out',
      'dead_lettered',
      'stale_lease',
      'missed_window',
    ]),
    latestRunId: z.string().nullable(),
    latestRunStatus: z.string().nullable(),
    latestSummary: z.string().nullable(),
    activeRunId: z.string().nullable(),
    leaseExpiresAt: IsoDateTimeSchema.nullable(),
    nextAction: z.string().nullable(),
  })
  .strict();
export type JobHealth = z.infer<typeof JobHealthSchema>;

export const JobRecoveryMetadataSchema = z
  .object({
    state: z.enum([
      'none',
      'pending',
      'running',
      'completed',
      'failed',
      'suppressed',
    ]),
    kind: z
      .enum([
        'setup_required',
        'missing_capability',
        'permission_denied',
        'permission_timeout',
      ])
      .nullable(),
    updatedAt: IsoDateTimeSchema.nullable(),
    attempts: z.number().int().nonnegative(),
    requirementType: z.string().nullable(),
    requirementId: z.string().nullable(),
    nextAction: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type JobRecoveryMetadata = z.infer<typeof JobRecoveryMetadataSchema>;

export const JobSetupSchema = z
  .object({
    state: z.enum([
      'ready',
      'missing_capability',
      'broker_unreachable',
      'credential_unknown',
      'browser_login_may_be_required',
      'mcp_missing_credential',
    ]),
    checkedAt: IsoDateTimeSchema.nullable(),
    fingerprint: z.string().nullable(),
    blockers: z.array(
      z
        .object({
          state: z.string(),
          message: z.string(),
          nextAction: z.string(),
          requirementType: z.string(),
          requirementId: z.string(),
        })
        .strict(),
    ),
    nextAction: z.string().nullable(),
  })
  .strict();
export type JobSetup = z.infer<typeof JobSetupSchema>;

export const JobToolAccessSchema = z
  .object({
    inheritedAgentTools: z.array(z.string()),
    effectiveAllowedTools: z.array(z.string()),
    projectedRuntimeTools: z.array(z.string()).optional(),
    source: z.string(),
  })
  .strict();
export type JobToolAccess = z.infer<typeof JobToolAccessSchema>;

export const JobToolAccessRequirementsSchema = z
  .array(z.string().min(1))
  .default([]);
export type JobToolAccessRequirements = z.infer<
  typeof JobToolAccessRequirementsSchema
>;

export const JobRequiredMcpServersSchema = z
  .array(z.string().min(1))
  .default([]);
export type JobRequiredMcpServers = z.infer<typeof JobRequiredMcpServersSchema>;

export const JobCapabilityRequirementImplementationSchema = z
  .object({
    kind: z.enum([
      'configured_access',
      'local_cli',
      'mcp_server',
      'builtin_tool',
    ]),
    name: z.string().min(1).optional(),
    executablePath: z.string().min(1).optional(),
    executableVersion: z.string().min(1).optional(),
    executableHash: z.string().min(1).optional(),
    commandTemplate: z.string().min(1).optional(),
    authPreflight: z.string().min(1).optional(),
    protectedPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type JobCapabilityRequirementImplementation = z.infer<
  typeof JobCapabilityRequirementImplementationSchema
>;

export const JobCapabilityRequirementSchema = z
  .object({
    capabilityId: z.string().min(1),
    reason: z.string().min(1),
    implementation: JobCapabilityRequirementImplementationSchema.optional(),
  })
  .strict();
export type JobCapabilityRequirement = z.infer<
  typeof JobCapabilityRequirementSchema
>;

export const JobCapabilityRequirementsSchema = z
  .array(JobCapabilityRequirementSchema)
  .default([]);
export type JobCapabilityRequirements = z.infer<
  typeof JobCapabilityRequirementsSchema
>;

export const CreateJobRequestSchema = z
  .object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    executionContext: JobRequestExecutionContextSchema,
    notificationRoutes: z.array(JobNotificationRouteSchema).optional(),
    capabilityRequirements: z.array(JobCapabilityRequirementSchema).optional(),
    toolAccessRequirements: z.array(z.string().min(1)).optional(),
    requiredMcpServers: z.array(z.string().min(1)).optional(),
    kind: z.enum(['manual', 'once', 'recurring']).optional(),
    runAt: IsoDateTimeSchema.optional(),
    schedule: z
      .object({
        type: z.enum(['cron', 'interval']).optional(),
        value: z.string().optional(),
      })
      .optional(),
    modelAlias: z.string().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const UpdateJobRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    executionContext: JobRequestExecutionContextSchema.optional(),
    notificationRoutes: z.array(JobNotificationRouteSchema).optional(),
    capabilityRequirements: z.array(JobCapabilityRequirementSchema).optional(),
    toolAccessRequirements: z.array(z.string().min(1)).optional(),
    requiredMcpServers: z.array(z.string().min(1)).optional(),
    status: z.enum(['active', 'paused']).optional(),
    modelAlias: z.string().nullable().optional(),
  })
  .strict();
export type UpdateJobRequest = z.infer<typeof UpdateJobRequestSchema>;

export const JobResponseSchema = z
  .object({
    jobId: z.string(),
    name: z.string(),
    prompt: z.string().optional(),
    promptPreview: z.string().optional(),
    fullPrompt: z.string().optional(),
    kind: z.enum(['manual', 'once', 'recurring']),
    status: JobStatusSchema,
    schedule: z
      .union([
        z.null(),
        z.object({ type: z.literal('once'), runAt: IsoDateTimeSchema }),
        z.object({ type: z.enum(['cron', 'interval']), value: z.string() }),
      ])
      .nullable(),
    executionContext: JobExecutionContextSchema,
    notificationRoutes: z.array(JobNotificationRouteSchema),
    ownerLabel: z.string().optional(),
    deliveryLabel: z.string().optional(),
    setupLabel: z.string().optional(),
    nextActionLabel: z.string().nullable().optional(),
    capabilityRequirements: z.array(JobCapabilityRequirementSchema),
    toolAccessRequirements: z.array(z.string()),
    requiredMcpServers: z.array(z.string()),
    setup: JobSetupSchema.optional(),
    nextRun: IsoDateTimeSchema.nullable(),
    lastRun: IsoDateTimeSchema.nullable(),
    staleness: JobStalenessSchema.nullable().optional(),
    health: JobHealthSchema.optional(),
    recovery: JobRecoveryMetadataSchema.optional(),
    modelAlias: z.string().nullable().optional(),
    modelSelection: JobModelSelectionSchema.optional(),
    model: JobModelPreviewSchema.nullable().optional(),
    groupScope: z.string(),
    sessionId: z.string().nullable(),
    target: JobResolvedTargetSchema.optional(),
    toolAccess: JobToolAccessSchema,
    recentRunErrors: z.array(JobRecentRunErrorSchema).optional(),
    silent: z.boolean().optional(),
  })
  .strict();
export type JobResponse = z.infer<typeof JobResponseSchema>;

export const CreateJobResponseSchema = z.object({
  jobId: z.string().optional(),
  dryRun: z.boolean().optional(),
  status: JobStatusSchema.optional(),
  setup: JobSetupSchema.optional(),
  modelAlias: z.string().nullable().optional(),
  modelSource: JobModelSourceSchema.optional(),
  modelSelection: JobModelSelectionSchema.optional(),
  model: JobModelPreviewSchema.nullable().optional(),
  runtimeContext: JobRuntimeContextPreviewSchema.optional(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

const ModelCacheSupportSchema = z.object({
  providerId: z.string(),
  providerLabel: z.string(),
  cacheProvider: z.string(),
  statusLabel: z.string(),
  prompt: z.object({
    mode: z.string(),
    automatic: z.boolean(),
    requestControl: z.string(),
    ttlOptions: z.array(z.string()),
    minimumTokenThresholds: z.array(
      z.object({
        modelFamily: z.string(),
        tokens: z.number().int().nonnegative(),
      }),
    ),
    usageFields: z.record(z.string(), z.unknown()),
    supported: z.boolean(),
    accounted: z.boolean(),
  }),
  response: z.object({
    mode: z.string(),
    enabledByDefault: z.boolean(),
    requestControl: z.string(),
    requestHeaders: z.array(z.string()),
    responseHeaders: z.array(z.string()),
    usageBehavior: z.string(),
    available: z.boolean(),
  }),
  tokenFields: z.array(z.string()),
});

export const ModelRecordSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  recommendedAlias: z.string(),
  responseFamily: z.string(),
  executionProviderId: z.string(),
  credentialProfileRef: z.string(),
  modelRoute: z.object({
    id: z.string(),
    label: z.string(),
    metadata: z
      .object({
        providerModelId: z.string(),
      })
      .strict(),
  }),
  capabilities: z
    .object({
      streaming: z.boolean(),
      toolUse: z.boolean(),
      mcpProjection: z.boolean(),
      browserProjection: z.boolean(),
      sandboxProjection: z.boolean(),
      providerSessionResume: z.boolean(),
      thinking: z.boolean(),
      tokenAccounting: z.boolean(),
      cacheAccounting: z.boolean(),
      structuredOutput: z.boolean(),
    })
    .strict(),
  supportedWorkloads: z.array(
    z.enum([
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ]),
  ),
  contextWindowTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  cacheMode: z.string(),
  cacheTokenFields: z.array(z.string()),
  cacheSupport: ModelCacheSupportSchema,
  supportsThinking: z.boolean(),
  supportsTools: z.boolean(),
  source: z.object({
    label: z.string(),
    url: z.string(),
    verifiedAt: z.string(),
  }),
  experimental: z.boolean(),
});
export type ModelRecord = z.infer<typeof ModelRecordSchema>;

export const ListModelsResponseSchema = z.object({
  models: z.array(ModelRecordSchema),
});
export type ListModelsResponse = z.infer<typeof ListModelsResponseSchema>;

export const ModelPresetSchema = z.string().min(1);
export type ModelPreset = z.infer<typeof ModelPresetSchema>;

export const ModelWorkloadSchema = z.enum([
  'chat',
  'one_time_job',
  'recurring_job',
  'memory_extractor',
  'memory_dreaming',
  'memory_consolidation',
]);
export type ModelWorkload = z.infer<typeof ModelWorkloadSchema>;

export const ModelDefaultSlotSchema = z.object({
  configuredAlias: z.string().nullable(),
  effectiveAlias: z.string().nullable(),
  source: z.string(),
  inherited: z.boolean(),
  workload: ModelWorkloadSchema,
  model: ModelRecordSchema.nullable(),
});
export type ModelDefaultSlot = z.infer<typeof ModelDefaultSlotSchema>;

export const ModelDefaultsResponseSchema = z.object({
  preset: z
    .object({
      id: ModelPresetSchema,
      label: z.string(),
    })
    .nullable(),
  chat: ModelDefaultSlotSchema,
  jobs: z.object({
    oneTime: ModelDefaultSlotSchema,
    recurring: ModelDefaultSlotSchema,
  }),
  memory: z.object({
    mode: z.literal('preset-managed'),
    extractor: ModelDefaultSlotSchema,
    dreaming: ModelDefaultSlotSchema,
    consolidation: ModelDefaultSlotSchema,
  }),
  defaults: z.object({
    chat: ModelDefaultSlotSchema,
    oneTime: ModelDefaultSlotSchema,
    recurring: ModelDefaultSlotSchema,
    memoryExtractor: ModelDefaultSlotSchema,
    memoryDreaming: ModelDefaultSlotSchema,
    memoryConsolidation: ModelDefaultSlotSchema,
  }),
});
export type ModelDefaultsResponse = z.infer<typeof ModelDefaultsResponseSchema>;

export const ModelDefaultsPatchRequestSchema = z
  .object({
    preset: ModelPresetSchema.optional(),
    chat: z.string().nullable().optional(),
    jobs: z.union([z.string(), z.null()]).optional(),
    oneTime: z.union([z.string(), z.null()]).optional(),
    recurring: z.union([z.string(), z.null()]).optional(),
    memory: z
      .union([z.literal('reset'), z.literal('preset-managed'), z.null()])
      .optional(),
  })
  .strict();
export type ModelDefaultsPatchRequest = z.infer<
  typeof ModelDefaultsPatchRequestSchema
>;

export const ModelPreviewTargetSchema = z.enum([
  'chat',
  'jobs',
  'job',
  'memory',
]);
export type ModelPreviewTarget = z.infer<typeof ModelPreviewTargetSchema>;

export const ModelPreviewRequestSchema = z
  .object({
    target: ModelPreviewTargetSchema,
    jobId: z.string().optional(),
    conversationJid: z.string().optional(),
    groupScope: z.string().optional(),
    kind: z.enum(['one-time', 'recurring']).optional(),
    task: z.enum(['extractor', 'dreaming', 'consolidation']).optional(),
  })
  .strict();
export type ModelPreviewRequest = z.infer<typeof ModelPreviewRequestSchema>;

export const ModelPreviewResponseSchema = z
  .object({
    target: ModelPreviewTargetSchema,
    jobId: z.string().optional(),
    scope: z.string().optional(),
    kind: z.enum(['one-time', 'recurring']).optional(),
    task: z.enum(['extractor', 'dreaming', 'consolidation']).optional(),
    selection: ModelDefaultSlotSchema,
    why: z.array(z.string()),
  })
  .strict();
export type ModelPreviewResponse = z.infer<typeof ModelPreviewResponseSchema>;
