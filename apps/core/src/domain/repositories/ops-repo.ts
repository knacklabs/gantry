import type {
  ChatInfo,
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  RegisteredGroup,
} from './domain-types.js';

export interface JobUpsertInput {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  script?: string | null;
  schedule_type: Job['schedule_type'];
  schedule_value: string;
  status?: Job['status'];
  linked_sessions: string[];
  session_id?: string | null;
  thread_id?: string | null;
  group_scope: string;
  created_by?: Job['created_by'];
  created_at?: string;
  updated_at?: string;
  next_run?: string | null;
  last_run?: string | null;
  silent?: boolean;
  cleanup_after_ms?: number;
  timeout_ms?: number;
  max_retries?: number;
  retry_backoff_ms?: number;
  max_consecutive_failures?: number;
  consecutive_failures?: number;
  execution_mode?: Job['execution_mode'];
  lease_run_id?: string | null;
  lease_expires_at?: string | null;
  pause_reason?: string | null;
}

export function makeSessionScopeKey(
  groupFolder: string,
  threadId?: string | null,
): string {
  const normalizedThreadId = threadId?.trim();
  return normalizedThreadId
    ? `${groupFolder}::thread:${normalizedThreadId}`
    : groupFolder;
}

export interface OpsRepository {
  storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void>;
  getAllChats(): Promise<ChatInfo[]>;
  storeMessage(msg: NewMessage): Promise<void>;
  getNewMessages(
    jids: string[],
    lastCursor: string,
    limit?: number,
  ): Promise<{
    messages: NewMessage[];
    newTimestamp: string;
  }>;
  getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit?: number,
    options?: { threadId?: string | null },
  ): Promise<NewMessage[]>;
  getMessageThreadIds(chatJid: string): Promise<Array<string | null>>;
  getLastBotMessageCursor(
    chatJid: string,
  ): Promise<{ timestamp: string; id: string } | undefined>;
  getLastBotMessageTimestamp(chatJid: string): Promise<string | undefined>;
  upsertJob(job: JobUpsertInput): Promise<{ created: boolean }>;
  getJobById(id: string): Promise<Job | undefined>;
  getAllJobs(): Promise<Job[]>;
  getRecentJobRuns(limit?: number): Promise<JobRun[]>;
  updateJob(id: string, updates: Partial<Job>): Promise<void>;
  deleteJob(id: string): Promise<void>;
  deleteExpiredCompletedOneTimeJobs(nowIso?: string): Promise<number>;
  claimDueJobRunStart(input: {
    jobId: string;
    runId: string;
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean>;
  releaseStaleJobLeases(nowIso?: string): Promise<number>;
  createJobRun(run: JobRun): Promise<boolean>;
  completeJobRun(
    runId: string,
    status: JobRun['status'],
    resultSummary?: string | null,
    errorSummary?: string | null,
  ): Promise<void>;
  markJobRunNotified(runId: string): Promise<void>;
  getJobRunById(runId: string): Promise<JobRun | undefined>;
  listJobRuns(jobId?: string, limit?: number): Promise<JobRun[]>;
  listDeadLetterRuns(limit?: number): Promise<JobRun[]>;
  addJobEvent(event: Omit<JobEvent, 'id'>): Promise<void>;
  listRecentJobEvents(
    limit?: number,
    filters?: { job_id?: string; run_id?: string; event_type?: string },
  ): Promise<JobEvent[]>;
  getRouterState(key: string): Promise<string | undefined>;
  setRouterState(key: string, value: string): Promise<void>;
  getSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<string | undefined>;
  getSessionResume?(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
  }): Promise<{
    agentSessionId: string;
    mode: 'provider_native' | 'db_replay';
    providerSessionId?: string;
    externalSessionId?: string;
    hydratedContextBlock?: string;
  }>;
  setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
    metadata?: {
      chatJid?: string;
      artifactRef?: string | null;
    },
  ): Promise<void>;
  expireProviderSession?(input: {
    providerSessionId?: string;
    agentSessionId?: string;
    provider?: string;
    externalSessionId?: string;
  }): Promise<void>;
  checkpointSessionSummary?(agentSessionId: string): Promise<void>;
  createSessionAgentRun?(input: {
    agentSessionId: string;
    cause: 'message' | 'job' | 'control' | 'manual';
  }): Promise<string | undefined>;
  completeSessionAgentRun?(input: {
    runId: string;
    status: 'completed' | 'failed' | 'canceled';
    resultSummary?: string | null;
    errorSummary?: string | null;
  }): Promise<void>;
  deleteSession(groupFolder: string, threadId?: string | null): Promise<void>;
  deleteSessionsByGroupFolder(groupFolder: string): Promise<void>;
  getAllSessions(): Promise<Record<string, string>>;
  getRegisteredGroup(jid: string): Promise<RegisteredGroup | undefined>;
  setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void>;
  deleteRegisteredGroup(jid: string): Promise<void>;
  getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>>;
}
