export type JobKind = 'manual' | 'once' | 'recurring';
export type JobExecutionMode = 'parallel' | 'serialized';
export type JobStatus =
  | 'active'
  | 'paused'
  | 'running'
  | 'completed'
  | 'dead_lettered';

export interface JobRecord {
  jobId: string;
  name: string;
  prompt: string;
  kind: JobKind;
  status: JobStatus;
  schedule:
    | null
    | { type: 'once'; runAt: string }
    | { type: 'cron' | 'interval'; value: string };
  linkedSessions: string[];
  nextRun: string | null;
  lastRun: string | null;
  executionMode: JobExecutionMode;
  threadId: string | null;
  groupScope: string;
  sessionId: string | null;
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
  sessionId: string;
  kind?: JobKind;
  runAt?: string;
  schedule?: { type: 'cron' | 'interval'; value: string };
  executionMode?: 'parallel' | 'serialized';
  threadId?: string;
  modelAlias?: string;
  modelProfileId?: string;
  dryRun?: boolean;
}

export interface CreateJobResponse {
  jobId: string;
  dryRun?: boolean;
  modelAlias?: string | null;
  modelSource?: string;
  model?: {
    displayName: string;
    provider: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    cachePolicy: string;
    modelProfileId: string;
  } | null;
}

export interface JobTriggerWaitResult {
  triggerId: string;
  runId: string;
  status: string;
  resultSummary: string | null;
  errorSummary: string | null;
}
