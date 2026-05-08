export type JobKind = 'manual' | 'once' | 'recurring';
export type JobExecutionMode = 'parallel' | 'serialized';
export type JobStatus =
  | 'active'
  | 'paused'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dead_lettered'
  | 'archived';
export type JobStaleness = 'missed_window';

export interface JobToolAccess {
  inheritedAgentTools: string[];
  jobExtraTools: string[];
  effectiveAllowedTools: string[];
  source: string;
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
  nextRun: string | null;
  lastRun: string | null;
  staleness?: JobStaleness | null;
  executionMode: JobExecutionMode;
  modelAlias: string | null;
  modelProfileId: string | null;
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

export interface ModelRecord {
  id: string;
  modelProfileId: string;
  displayName: string;
  aliases: string[];
  recommendedAlias: string;
  provider: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  cacheMode: string;
  cacheTokenFields: string[];
  supportsThinking: boolean;
  supportsTools: boolean;
  experimental: boolean;
}

export interface CreateJobInput {
  name: string;
  prompt: string;
  executionContext: JobRequestExecutionContext;
  notificationRoutes?: JobNotificationRoute[];
  kind?: JobKind;
  runAt?: string;
  schedule?: { type: 'cron' | 'interval'; value: string };
  executionMode?: 'parallel' | 'serialized';
  modelAlias?: string;
  modelProfileId?: string;
  allowedTools?: string[];
  dryRun?: boolean;
}

export interface UpdateJobInput {
  name?: string;
  prompt?: string;
  executionMode?: 'parallel' | 'serialized';
  executionContext?: JobRequestExecutionContext;
  notificationRoutes?: JobNotificationRoute[];
  status?: 'active' | 'paused';
  modelAlias?: string | null;
  modelProfileId?: string | null;
  allowedTools?: string[];
}

export interface ListJobsInput {
  agentId?: string;
  groupScope?: string;
  conversationJid?: string;
  kind?: JobKind;
  status?: JobStatus | JobStatus[];
  limit?: number;
}

export interface CreateJobResponse {
  jobId?: string;
  dryRun?: boolean;
  modelAlias?: string | null;
  modelSource?: JobModelSource;
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
  modelProfileId: string;
}

export interface JobTriggerWaitResult {
  triggerId: string;
  runId: string;
  status: string;
  resultSummary: string | null;
  errorSummary: string | null;
}
