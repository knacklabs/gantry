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
  | 'draft_only'
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
    | 'draft_only'
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
  groupScope: string;
  sessionId: string | null;
}

export interface JobRequestExecutionContext {
  conversationJid: string;
  threadId: string | null;
  groupScope: string;
  sessionId: string;
}

export interface JobNotificationRoute {
  conversationJid: string;
  threadId: string | null;
  label: string;
}

export type JobCapabilityRequirementImplementationKind =
  | 'configured_access'
  | 'local_cli'
  | 'mcp_server'
  | 'builtin_tool';

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
  capabilityRequirements: JobCapabilityRequirement[];
  toolAccessRequirements: string[];
  requiredMcpServers: string[];
  setup?: JobSetup;
  nextRun: string | null;
  lastRun: string | null;
  staleness?: JobStaleness | null;
  health?: JobHealth;
  modelAlias: string | null;
  modelSelection?: {
    alias: string | null;
    source: string;
    explicit: boolean;
  };
  model: JobModelPreview | null;
  groupScope: string;
  sessionId: string | null;
  target?: {
    appId: string;
    agentId: string;
    groupScope: string;
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
  provider: string;
  providerId: 'anthropic' | 'openrouter';
  providerLabel: string;
  providerSlug: string;
  supportedWorkloads: ModelWorkload[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  cacheMode: string;
  cacheTokenFields: string[];
  supportsThinking: boolean;
  supportsTools: boolean;
  source: {
    label: string;
    url: string;
    verifiedAt: string;
  };
  experimental: boolean;
}

export type ModelProviderPreset = 'anthropic' | 'openrouter';
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
    id: ModelProviderPreset;
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
  provider?: ModelProviderPreset;
  chat?: string | null;
  jobs?: string | null;
  oneTime?: string | null;
  recurring?: string | null;
  memory?: 'reset' | 'provider-managed' | null;
}

export type ModelPreviewTarget = 'chat' | 'jobs' | 'job' | 'memory';

export interface ModelPreviewRequest {
  target: ModelPreviewTarget;
  jobId?: string;
  conversationJid?: string;
  groupScope?: string;
  kind?: 'one-time' | 'recurring';
  task?: 'extractor' | 'dreaming' | 'consolidation';
}

export interface ModelPreviewResponse {
  target: ModelPreviewTarget;
  jobId?: string;
  scope?: string;
  kind?: 'one-time' | 'recurring';
  task?: 'extractor' | 'dreaming' | 'consolidation';
  selection: ModelDefaultSlot;
  why: string[];
}

export interface CreateJobInput {
  name: string;
  prompt: string;
  executionContext: JobRequestExecutionContext;
  notificationRoutes?: JobNotificationRoute[];
  capabilityRequirements?: JobCapabilityRequirement[];
  toolAccessRequirements?: string[];
  requiredMcpServers?: string[];
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
  capabilityRequirements?: JobCapabilityRequirement[];
  toolAccessRequirements?: string[];
  requiredMcpServers?: string[];
  status?: 'active' | 'paused';
  modelAlias?: string | null;
}

export interface ListJobsInput {
  agentId?: string;
  groupScope?: string;
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
    | 'personal_assistant'
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
  | 'group.agentConfig.model';

export interface JobModelPreview {
  displayName: string;
  provider: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  cachePolicy: string;
}

export interface JobTriggerWaitResult {
  triggerId: string;
  runId: string;
  status: string;
  resultSummary: string | null;
  errorSummary: string | null;
}
