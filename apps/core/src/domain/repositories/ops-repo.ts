import type {
  ChatInfo,
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  ConversationRoute,
} from './domain-types.js';
import type { RuntimeEventType } from '../events/runtime-event-types.js';
import type { ExecutionProviderId } from '../sessions/sessions.js';

export interface JobUpsertInput {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  schedule_type: Job['schedule_type'];
  schedule_value: string;
  status?: Job['status'];
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
  lease_run_id?: string | null;
  lease_expires_at?: string | null;
  pause_reason?: string | null;
  execution_context?: Job['execution_context'];
  notification_routes?: Job['notification_routes'];
  capability_requirements?: Job['capability_requirements'];
  required_tools?: string[];
  required_mcp_servers?: string[];
  setup_state?: Job['setup_state'];
}

export interface JobListFilters {
  appId?: string;
  statuses?: string[];
  groupScope?: string;
  threadId?: string | null;
  agentId?: string;
  kind?: 'manual' | 'once' | 'recurring';
  conversationJid?: string;
  limit?: number;
}

export interface JobRunListFilters {
  jobIds?: string[];
  ownerAppId?: string;
}

export interface JobEventListFilters {
  app_id?: string;
  owner_app_id?: string;
  job_id?: string;
  job_ids?: string[];
  run_id?: string;
  event_type?: RuntimeEventType;
  since_id?: number;
  since?: string;
}

export function makeSessionScopeKey(
  agentFolder: string,
  threadId?: string | null,
  scope?: {
    conversationJid?: string | null;
    conversationKind?: 'dm' | 'channel';
    userId?: string | null;
    jobId?: string | null;
  },
): string {
  const conversationJid = scope?.conversationJid?.trim();
  const dmUserId =
    scope?.conversationKind === 'dm' ? scope.userId?.trim() : undefined;
  const normalizedThreadId = threadId?.trim();
  const jobId = scope?.jobId?.trim();
  const parts = [agentFolder];
  if (conversationJid) {
    parts.push(`conversation:${encodeSessionScopeComponent(conversationJid)}`);
  }
  if (dmUserId) {
    parts.push(`user:${encodeSessionScopeComponent(dmUserId)}`);
  }
  if (normalizedThreadId) {
    parts.push(`thread:${encodeSessionScopeComponent(normalizedThreadId)}`);
  }
  if (jobId) {
    parts.push(`job:${encodeSessionScopeComponent(jobId)}`);
  }
  return parts.join('::');
}

function encodeSessionScopeComponent(value: string): string {
  return encodeURIComponent(value);
}

export interface RuntimeChatMetadataRepository {
  storeChatMetadata(
    conversationJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void>;
  getAllChats(): Promise<ChatInfo[]>;
}

export interface RuntimeMessageRepository {
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
    conversationJid: string,
    sinceCursor: string,
    limit?: number,
    options?: { threadId?: string | null },
  ): Promise<NewMessage[]>;
  getMessageThreadIds(conversationJid: string): Promise<Array<string | null>>;
  getLastBotMessageCursor(
    conversationJid: string,
  ): Promise<{ timestamp: string; id: string } | undefined>;
  getLastBotMessageTimestamp(
    conversationJid: string,
  ): Promise<string | undefined>;
}

export interface RuntimeJobRepository {
  upsertJob(job: JobUpsertInput): Promise<{ created: boolean }>;
  getJobById(id: string): Promise<Job | undefined>;
  getAllJobs(): Promise<Job[]>;
  listJobs(filters?: JobListFilters): Promise<Job[]>;
  getRecentJobRuns(limit?: number): Promise<JobRun[]>;
  updateJob(id: string, updates: Partial<Job>): Promise<void>;
  deleteJob(id: string): Promise<void>;
  deleteExpiredCompletedOneTimeJobs(nowIso?: string): Promise<number>;
  claimDueJobRunStart(input: {
    jobId: string;
    runId: string;
    executionProviderId: ExecutionProviderId;
    workerId?: string | null;
    leaseOwner?: string | null;
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean>;
  updateAgentRunProviderMetadata?(input: {
    runId: string;
    runIds?: string[];
    providerRunId?: string | null;
    providerSessionId?: string | null;
  }): Promise<void>;
  releaseStaleJobLeases(nowIso?: string): Promise<ReleasedStaleJobLease[]>;
  releaseInterruptedJobLeases?(
    nowIso?: string,
  ): Promise<ReleasedStaleJobLease[]>;
  createJobRun(run: JobRun): Promise<boolean>;
  completeJobRun(
    runId: string,
    status: JobRun['status'],
    resultSummary?: string | null,
    errorSummary?: string | null,
  ): Promise<void>;
  markJobRunNotified(runId: string): Promise<void>;
  getJobRunById(runId: string): Promise<JobRun | undefined>;
  listJobRuns(
    jobId?: string,
    limit?: number,
    filters?: JobRunListFilters,
  ): Promise<JobRun[]>;
  listDeadLetterRuns(limit?: number): Promise<JobRun[]>;
  listRecentJobEvents(
    limit?: number,
    filters?: JobEventListFilters,
  ): Promise<JobEvent[]>;
}

export interface ReleasedStaleJobLease {
  jobId: string;
  runId: string | null;
  releasedAt: string;
  runTimedOut: boolean;
  reason: 'lease_expired' | 'runtime_restarted';
}

export interface RuntimeRouterStateRepository {
  getRouterState(key: string): Promise<string | undefined>;
  setRouterState(key: string, value: string): Promise<void>;
}

export interface RuntimeAgentSessionRepository {
  getAgentTurnContext?(input: {
    agentFolder: string;
    executionProviderId: ExecutionProviderId;
    conversationJid: string;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
    query?: string;
    hydrateMemory?: boolean;
  }): Promise<{
    appId: string;
    agentId: string;
    agentSessionId: string;
    agentSessionResetAt?: string | null;
    providerSessionId?: string;
    externalSessionId?: string;
    memoryContextBlock?: string;
  }>;
  setSession(
    agentFolder: string,
    sessionId: string,
    threadId: string | null | undefined,
    metadata: {
      executionProviderId: ExecutionProviderId;
      conversationJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      jobId?: string;
      expectedAgentSessionId?: string;
      expectedAgentSessionResetAt?: string | null;
    },
  ): Promise<boolean | void>;
  expireProviderSession?(input: {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
  }): Promise<void>;
  createSessionAgentRun?(input: {
    agentSessionId: string;
    executionProviderId: ExecutionProviderId;
    providerSessionId?: string | null;
    cause: 'message' | 'job' | 'control' | 'manual';
  }): Promise<string | undefined>;
  updateAgentRunProviderMetadata?(input: {
    runId: string;
    runIds?: string[];
    providerRunId?: string | null;
    providerSessionId?: string | null;
  }): Promise<void>;
  completeSessionAgentRun?(input: {
    runId: string;
    status: 'completed' | 'failed' | 'canceled';
    resultSummary?: string | null;
    errorSummary?: string | null;
  }): Promise<void>;
  deleteSession(
    agentFolder: string,
    threadId?: string | null,
    metadata?: {
      conversationJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      agentId?: string;
    },
  ): Promise<void>;
  deleteSessionsByAgentFolder(agentFolder: string): Promise<void>;
}

export interface RuntimeConversationRouteRepository {
  getConversationRoute(jid: string): Promise<ConversationRoute | undefined>;
  setConversationRoute(jid: string, group: ConversationRoute): Promise<void>;
  deleteConversationRoute(jid: string): Promise<void>;
  getAllConversationRoutes(): Promise<Record<string, ConversationRoute>>;
}
