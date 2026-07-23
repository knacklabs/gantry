export type JobKind = 'manual' | 'once' | 'recurring';
export type JobStatus =
  | 'active'
  | 'paused'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dead_lettered'
  | 'archived';
export type JobStaleness = 'missed_window';

export type JobHealthState =
  | 'ready'
  | 'missing_capability'
  | 'broker_unreachable'
  | 'credential_unknown'
  | 'browser_login_may_be_required'
  | 'mcp_missing_credential'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_permission'
  | 'timed_out'
  | 'dead_lettered'
  | 'stale_lease'
  | 'missed_window';

export interface JobHealth {
  state: JobHealthState;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestSummary: string | null;
  activeRunId: string | null;
  leaseExpiresAt: string | null;
  nextAction: string | null;
}

export interface JobToolAccess {
  inheritedAgentTools: string[];
  effectiveAllowedTools: string[];
  projectedRuntimeTools?: string[];
  source: string;
}

export interface JobSetup {
  state: Extract<
    JobHealthState,
    | 'ready'
    | 'missing_capability'
    | 'broker_unreachable'
    | 'credential_unknown'
    | 'browser_login_may_be_required'
    | 'mcp_missing_credential'
  >;
  checkedAt: string | null;
  fingerprint: string | null;
  blockers: Array<{
    state: string;
    message: string;
    nextAction: string;
    requirementType: string;
    requirementId: string;
  }>;
  nextAction: string | null;
}

export interface JobExecutionContext {
  conversationJid: string;
  threadId: string | null;
  workspaceKey: string;
  sessionId: string | null;
}

export interface JobRequestExecutionContext {
  conversationJid: string;
  threadId: string | null;
  workspaceKey: string;
  sessionId: string;
}

export interface JobNotificationRoute {
  conversationJid: string;
  threadId: string | null;
  providerAccountId?: string | null;
  label: string;
}

export type JobCapabilityRequirementImplementationKind =
  'configured_access' | 'local_cli' | 'mcp_server' | 'builtin_tool';

export interface JobCapabilityRequirementImplementation {
  kind: JobCapabilityRequirementImplementationKind;
  name?: string;
  executablePath?: string;
  executableVersion?: string;
  executableHash?: string;
  commandTemplate?: string;
  authPreflight?: string;
  protectedPaths?: string[];
}

export interface JobCapabilityRequirement {
  capabilityId: string;
  reason: string;
  implementation?: JobCapabilityRequirementImplementation;
}

export type JobAccessRequirementTarget =
  | { kind: 'tool_rule'; rule: string }
  | {
      kind: 'capability';
      capabilityId: string;
      implementation?: JobCapabilityRequirementImplementation;
    }
  | { kind: 'mcp_server'; server: string };

export interface JobAccessRequirement {
  target: JobAccessRequirementTarget;
  reason?: string;
}

export interface JobRecoveryMetadata {
  state: 'none' | 'pending' | 'running' | 'completed' | 'failed' | 'suppressed';
  kind:
    | 'setup_required'
    | 'missing_capability'
    | 'permission_denied'
    | 'permission_timeout'
    | null;
  updatedAt: string | null;
  attempts: number;
  requirementType: string | null;
  requirementId: string | null;
  nextAction: string | null;
  lastError: string | null;
}

export interface JobRecord {
  jobId: string;
  name: string;
  prompt?: string;
  promptPreview?: string;
  fullPrompt?: string;
  kind: JobKind;
  status: JobStatus;
  schedule:
    | null
    | { type: 'once'; runAt: string }
    | { type: 'cron' | 'interval'; value: string };
  executionContext: JobExecutionContext;
  notificationRoutes: JobNotificationRoute[];
  ownerLabel?: string;
  deliveryLabel?: string;
  setupLabel?: string;
  nextActionLabel?: string | null;
  accessRequirements: JobAccessRequirement[];
  setup?: JobSetup;
  nextRun: string | null;
  lastRun: string | null;
  staleness?: JobStaleness | null;
  health?: JobHealth;
  recovery?: JobRecoveryMetadata;
  modelAlias: string | null;
  modelSelection?: {
    alias: string | null;
    source: string;
    explicit: boolean;
  };
  model: JobModelPreview | null;
  workspaceKey: string;
  sessionId: string | null;
  target?: {
    appId: string;
    agentId: string;
    workspaceKey: string;
    conversationJids: string[];
    threadId: string | null;
  };
  toolAccess: JobToolAccess;
  recentRunErrors?: Array<{
    runId: string;
    status: string;
    errorSummary: string;
    endedAt: string | null;
  }>;
  silent?: boolean;
}

export interface JobEventRecord {
  id: number;
  job_id: string;
  run_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
}

export interface ModelRecord {
  id: string;
  displayName: string;
  aliases: string[];
  recommendedAlias: string;
  responseFamily: string;
  // Read-only support matrix: the public harness that can run this model and
  // its internal execution provider diagnostic.
  executionRoutes: Array<{
    harness: string;
    executionProviderId: string;
  }>;
  credentialProfileRef: string;
  modelRoute: {
    id: string;
    label: string;
    metadata: {
      providerModelId: string;
    };
  };
  capabilities: {
    streaming: boolean;
    toolUse: boolean;
    mcpProjection: boolean;
    browserProjection: boolean;
    sandboxProjection: boolean;
    providerSessionResume: boolean;
    thinking: boolean;
    tokenAccounting: boolean;
    cacheAccounting: boolean;
    structuredOutput: boolean;
  };
  supportedWorkloads: ModelWorkload[];
  // Optional: deepagents-lane entries omit static limits; reported at runtime
  // from the engine's model profile.
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  cacheMode: string;
  cacheTokenFields: string[];
  cacheSupport: {
    providerId: string;
    providerLabel: string;
    cacheProvider: string;
    statusLabel: string;
    prompt: {
      mode: string;
      automatic: boolean;
      requestControl: string;
      ttlOptions: string[];
      minimumTokenThresholds: Array<{
        modelFamily: string;
        tokens: number;
      }>;
      usageFields: Record<string, unknown>;
      supported: boolean;
      accounted: boolean;
    };
    response: {
      mode: string;
      enabledByDefault: boolean;
      requestControl: string;
      requestHeaders: string[];
      responseHeaders: string[];
      usageBehavior: string;
      available: boolean;
    };
    tokenFields: string[];
  };
  supportsThinking?: boolean;
  supportsTools?: boolean;
  /** Curated per-million-token pricing (USD); omitted when no curated price. */
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  /**
   * Credential-aware availability for the requesting app: true when the model's
   * provider has an active Model Access credential. Present only on the model
   * list endpoint; omitted when a model is embedded in a default slot.
   */
  available?: boolean;
  source: {
    label: string;
    url: string;
    verifiedAt: string;
  };
  experimental: boolean;
}

export type ModelWorkload =
  | 'chat'
  | 'one_time_job'
  | 'recurring_job'
  | 'memory_extractor'
  | 'memory_dreaming'
  | 'memory_consolidation';

export interface ModelDefaultSlot {
  configuredAlias: string | null;
  effectiveAlias: string | null;
  source: string;
  inherited: boolean;
  workload: ModelWorkload;
  model: ModelRecord | null;
}

export interface ModelDefaultsResponse {
  provider: {
    id: string;
    label: string;
  } | null;
  chat: ModelDefaultSlot;
  jobs: {
    oneTime: ModelDefaultSlot;
    recurring: ModelDefaultSlot;
  };
  memory: {
    mode: 'provider-managed';
    extractor: ModelDefaultSlot;
    dreaming: ModelDefaultSlot;
    consolidation: ModelDefaultSlot;
  };
  defaults: {
    chat: ModelDefaultSlot;
    oneTime: ModelDefaultSlot;
    recurring: ModelDefaultSlot;
    memoryExtractor: ModelDefaultSlot;
    memoryDreaming: ModelDefaultSlot;
    memoryConsolidation: ModelDefaultSlot;
  };
}

export interface ModelDefaultsPatchRequest {
  chat?: string | null;
  jobs?: string | null;
  oneTime?: string | null;
  recurring?: string | null;
  memory?: 'reset' | 'provider-managed' | null;
}

export type ModelPreviewTarget = 'chat' | 'jobs' | 'job' | 'agent' | 'memory';

export interface ModelPreviewRequest {
  target: ModelPreviewTarget;
  jobId?: string;
  // For target 'agent': resolve a model alias against the agent's engine.
  agentId?: string;
  modelAlias?: string;
  conversationJid?: string;
  workspaceKey?: string;
  kind?: 'one-time' | 'recurring';
  task?: 'extractor' | 'dreaming' | 'consolidation';
}

export interface ModelPreviewResponse {
  target: ModelPreviewTarget;
  jobId?: string;
  agentId?: string;
  scope?: string;
  kind?: 'one-time' | 'recurring';
  task?: 'extractor' | 'dreaming' | 'consolidation';
  // Resolved-route diagnostics for target 'agent'. `agentHarness` is the public
  // selected harness; `executionProviderId` is the internal read-only
  // diagnostic; `incompatible` carries the locked plan copy when the
  // model/harness pairing is unsupported.
  agentHarness?: string;
  credentialProfile?: string;
  executionProviderId?: string;
  incompatible?: string;
  selection: ModelDefaultSlot;
  why: string[];
}

export interface CreateJobInput {
  name: string;
  prompt: string;
  executionContext: JobRequestExecutionContext;
  notificationRoutes?: JobNotificationRoute[];
  accessRequirements?: JobAccessRequirement[];
  kind?: JobKind;
  runAt?: string;
  schedule?: { type: 'cron' | 'interval'; value: string };
  modelAlias?: string;
  dryRun?: boolean;
}

export interface UpdateJobInput {
  name?: string;
  prompt?: string;
  executionContext?: JobRequestExecutionContext;
  notificationRoutes?: JobNotificationRoute[];
  accessRequirements?: JobAccessRequirement[];
  status?: 'active' | 'paused';
  modelAlias?: string | null;
}

export interface ListJobsInput {
  agentId?: string;
  workspaceKey?: string;
  conversationJid?: string;
  kind?: JobKind;
  status?: JobStatus | JobStatus[];
  limit?: number;
}

export interface ListJobEventsInput {
  runId?: string;
  eventType?: string;
  sinceId?: number;
  since?: string;
  limit?: number;
}

export interface CreateJobResponse {
  jobId?: string;
  dryRun?: boolean;
  status?: JobStatus;
  setup?: JobSetup;
  modelAlias?: string | null;
  modelSource?: JobModelSource;
  modelSelection?: {
    alias: string | null;
    source: string;
    explicit: boolean;
  };
  model?: JobModelPreview | null;
  runtimeContext?: JobRuntimeContextPreview;
}

export interface JobRuntimeContextPreview {
  executionContext: JobExecutionContext;
  notificationRoutes: JobNotificationRoute[];
  browserProfileLabel: string;
  browserProfileName: string;
  persona:
    | 'developer'
    | 'generalist'
    | 'sales'
    | 'marketing'
    | 'operations'
    | 'research';
}

export type JobModelSource =
  | 'explicit'
  | 'system default'
  | 'settings.yaml agents.<agent>.model'
  | 'settings.yaml agents.<agent>.one_time_job_default_model'
  | 'settings.yaml agents.<agent>.recurring_job_default_model'
  | 'settings.yaml agent.default_model'
  | 'settings.yaml agent.one_time_job_default_model'
  | 'settings.yaml agent.recurring_job_default_model'
  | 'conversation.agentConfig.model';

export interface JobModelPreview {
  displayName: string;
  responseFamily: string;
  modelRoute: {
    id: string;
    label: string;
  };
  // Optional: DeepAgents job-eligible models omit static limits (matching
  // ModelRecord), so JSON.stringify drops them from valid job preview responses.
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  cachePolicy: string;
}

export interface JobTriggerWaitResult {
  triggerId: string;
  runId: string;
  status: string;
  resultSummary: string | null;
  errorSummary: string | null;
}
