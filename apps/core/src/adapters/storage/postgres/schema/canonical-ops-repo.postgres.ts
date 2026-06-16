import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  ChatInfo,
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  ConversationRoute,
} from '../../../../domain/repositories/domain-types.js';
import type {
  AgentSession,
  ExecutionProviderId,
} from '../../../../domain/sessions/sessions.js';
import { assertSafeExecutionProviderId } from '../../../../domain/sessions/execution-provider-id.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import type { LiveAdmissionWorkItemNotifier } from '../../../../domain/ports/live-turns.js';
import type {
  JobEventListFilters,
  JobListFilters,
  JobRunListFilters,
  JobUpsertInput,
  ReleasedStaleJobLease,
  RuntimeAgentSessionRepository,
  RuntimeChatMetadataRepository,
  RuntimeConversationRouteRepository,
  RuntimeJobRepository,
  RuntimeMessageRepository,
  RuntimeRouterStateRepository,
} from '../../../../domain/repositories/ops-repo.js';
import type { RuntimeEventPublishInput } from '../../../../domain/events/events.js';
import { PostgresCanonicalBindingRepository } from '../repositories/canonical-binding-repository.postgres.js';
import {
  type CanonicalDb,
  DEFAULT_LLM_PROFILE_ID,
  PostgresCanonicalGraphRepository,
  configVersionIdForAgent,
} from '../repositories/canonical-graph-repository.postgres.js';
import { PostgresCanonicalJobRepository } from '../repositories/canonical-job-repository.postgres.js';
import { PostgresCanonicalMessageRepository } from '../repositories/canonical-message-repository.postgres.js';
import { PostgresCanonicalRouterStateRepository } from '../repositories/canonical-router-state-repository.postgres.js';
import { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';
import { createPostgresDomainRepositories } from '../repositories/domain-repositories.postgres.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { engineForExecutionProviderId } from '../../../../shared/model-execution-route.js';
import { CanonicalBindingOpsService } from '../services/canonical-binding-ops-service.js';
import { CanonicalJobOpsService } from '../services/canonical-job-ops-service.js';
import { CanonicalMessageOpsService } from '../services/canonical-message-ops-service.js';
import { CanonicalSessionOpsService } from '../services/canonical-session-ops-service.js';
import { redactProviderSessionHandlesInText } from '../../../../shared/provider-session-redaction.js';
import { nowIso } from '../../../../shared/time/datetime.js';

interface SessionRuntimeOptions {
  memoryItemLimit?: number;
  maxMemoryContextChars?: number;
  loadAppMemoryItems?: (input: {
    session: AgentSession;
    limit: number;
    conversationKind?: string;
    query?: string;
  }) => Promise<
    Array<{
      id: string;
      kind: string;
      key: string;
      value: string;
      subject: Record<string, unknown>;
    }>
  >;
}

interface RuntimeEventPublisher {
  publish(input: RuntimeEventPublishInput): Promise<unknown>;
}

export class PostgresRuntimeRepositoryBundle
  implements
    RuntimeChatMetadataRepository,
    RuntimeMessageRepository,
    RuntimeJobRepository,
    RuntimeRouterStateRepository,
    RuntimeAgentSessionRepository,
    RuntimeConversationRouteRepository
{
  private readonly graph: PostgresCanonicalGraphRepository;
  private readonly messages: CanonicalMessageOpsService;
  private readonly jobs: CanonicalJobOpsService;
  private readonly sessions: CanonicalSessionOpsService;
  private readonly bindings: CanonicalBindingOpsService;
  private readonly routerState: PostgresCanonicalRouterStateRepository;

  constructor(
    private readonly pool: Pool,
    private readonly db: CanonicalDb,
    private readonly options: {
      runtimeEvents: RuntimeEventPublisher;
      sessions?: SessionRuntimeOptions;
      liveAdmissionNotifier?: LiveAdmissionWorkItemNotifier;
    },
  ) {
    const repositories = createPostgresDomainRepositories(this.db, this.pool);
    this.graph = new PostgresCanonicalGraphRepository(this.db);
    this.messages = new CanonicalMessageOpsService(
      new PostgresCanonicalMessageRepository(this.db),
      this.options.liveAdmissionNotifier,
    );
    this.jobs = new CanonicalJobOpsService(
      new PostgresCanonicalJobRepository(this.db),
    );
    this.sessions = new CanonicalSessionOpsService(
      new PostgresCanonicalSessionRepository(this.db),
      {
        ...repositories,
        loadAppMemoryItems: this.options.sessions?.loadAppMemoryItems,
      },
      this.options.sessions,
    );
    this.bindings = new CanonicalBindingOpsService(
      new PostgresCanonicalBindingRepository(this.db),
    );
    this.routerState = new PostgresCanonicalRouterStateRepository(this.db);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    await this.graph.ensureConversation(chatJid, {
      name,
      channel,
      isGroup,
      timestamp,
    });
  }

  async getAllChats(): Promise<ChatInfo[]> {
    return this.graph.listChats();
  }

  async storeMessage(msg: NewMessage): Promise<void> {
    await this.messages.storeMessage(msg);
  }

  async storeMessageWithLiveAdmission(
    msg: NewMessage,
    admission: {
      appId: string;
      agentId?: string | null;
      agentSessionId?: string | null;
      triggerDecision?: Record<string, unknown>;
      now?: string;
    },
  ) {
    return this.messages.storeMessageWithLiveAdmission(msg, admission);
  }

  async getNewMessages(
    jids: string[],
    lastCursor: string,
    limit: number = 200,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    return this.messages.getNewMessages(jids, lastCursor, limit);
  }

  async getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit: number = 200,
    options: { threadId?: string | null } = {},
  ): Promise<NewMessage[]> {
    return this.messages.getMessagesSince(chatJid, sinceCursor, limit, options);
  }

  async getMessageThreadIds(chatJid: string): Promise<Array<string | null>> {
    return this.messages.getMessageThreadIds(chatJid);
  }

  async getLastBotMessageCursor(
    chatJid: string,
  ): Promise<{ timestamp: string; id: string } | undefined> {
    return this.messages.getLastBotMessageCursor(chatJid);
  }

  async getLastBotMessageTimestamp(
    chatJid: string,
  ): Promise<string | undefined> {
    return this.messages.getLastBotMessageTimestamp(chatJid);
  }

  async upsertJob(job: JobUpsertInput): Promise<{ created: boolean }> {
    return this.jobs.upsertJob(job);
  }

  async getJobById(id: string): Promise<Job | undefined> {
    return this.jobs.getJobById(id);
  }

  async getAllJobs(): Promise<Job[]> {
    return this.jobs.getAllJobs();
  }

  async listJobs(filters?: JobListFilters): Promise<Job[]> {
    return this.jobs.listJobs(filters);
  }

  async getRecentJobRuns(limit = 200): Promise<JobRun[]> {
    return this.jobs.getRecentJobRuns(limit);
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    await this.jobs.updateJob(id, updates);
  }

  async deleteJob(id: string): Promise<void> {
    await this.jobs.deleteJob(id);
  }

  async deleteExpiredCompletedOneTimeJobs(nowIso?: string): Promise<number> {
    return this.jobs.deleteExpiredCompletedOneTimeJobs(nowIso);
  }

  async claimDueJobRunStart(input: {
    jobId: string;
    runId: string;
    executionProviderId: ExecutionProviderId;
    workerId?: string | null;
    leaseOwner?: string | null;
    workerInstanceId: string;
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<RunLease | null> {
    return this.jobs.claimDueJobRunStart(input);
  }

  async settleJobRunLease(input: {
    runId: string;
    leaseToken: string;
    outcome: 'completed' | 'failed' | 'released';
    allowAlreadySettled?: boolean;
  }): Promise<boolean> {
    return this.jobs.settleJobRunLease(input);
  }

  async releaseStaleJobLeases(
    nowIso?: string,
  ): Promise<ReleasedStaleJobLease[]> {
    return this.jobs.releaseStaleJobLeases(nowIso);
  }

  async createJobRun(run: JobRun): Promise<boolean> {
    return this.jobs.createJobRun(run);
  }

  async completeJobRun(
    runId: string,
    status: JobRun['status'],
    resultSummary: string | null = null,
    errorSummary: string | null = null,
  ): Promise<void> {
    await this.jobs.completeJobRun(runId, status, resultSummary, errorSummary);
  }

  async completeJobRunWithLease(input: {
    runId: string;
    leaseToken: string;
    workerInstanceId: string;
    fencingVersion: number;
    status: JobRun['status'];
    resultSummary?: string | null;
    errorSummary?: string | null;
  }): Promise<boolean> {
    return this.jobs.completeJobRunWithLease(input);
  }

  async finalizeJobRunLease(input: {
    runId: string;
    leaseToken: string;
    workerInstanceId: string;
    fencingVersion: number;
    leaseOutcome: 'completed' | 'failed' | 'released';
    runStatus: JobRun['status'];
    resultSummary?: string | null;
    errorSummary?: string | null;
  }): Promise<boolean> {
    return this.jobs.finalizeJobRunLease(input);
  }

  async finalizeJobRunWithLease(input: {
    jobId: string;
    runId: string;
    leaseToken: string;
    workerInstanceId: string;
    fencingVersion: number;
    leaseOutcome: 'completed' | 'failed' | 'released';
    runStatus: JobRun['status'];
    resultSummary?: string | null;
    errorSummary?: string | null;
    jobUpdates: Partial<Job>;
  }): Promise<boolean> {
    return this.jobs.finalizeJobRunWithLease(input);
  }

  async markJobRunNotified(
    runId: string,
    lease?: {
      leaseToken: string;
      workerInstanceId: string;
      fencingVersion: number;
    },
  ): Promise<boolean> {
    return this.jobs.markJobRunNotified(runId, lease);
  }

  async getJobRunById(runId: string): Promise<JobRun | undefined> {
    return this.jobs.getJobRunById(runId);
  }

  async listJobRuns(
    jobId?: string,
    limit = 50,
    filters?: JobRunListFilters,
  ): Promise<JobRun[]> {
    return this.jobs.listJobRuns(jobId, limit, filters);
  }

  async listDeadLetterRuns(limit = 50): Promise<JobRun[]> {
    return this.jobs.listDeadLetterRuns(limit);
  }

  async listRecentJobEvents(
    limit = 200,
    filters?: JobEventListFilters,
  ): Promise<JobEvent[]> {
    return this.jobs.listRecentJobEvents(limit, filters);
  }

  async getRouterState(key: string): Promise<string | undefined> {
    return this.routerState.get(key);
  }

  async setRouterState(key: string, value: string): Promise<void> {
    await this.routerState.set(key, value);
  }

  async setSession(
    agentFolder: string,
    sessionId: string,
    threadId: string | null | undefined,
    metadata: {
      appId?: string;
      executionProviderId: ExecutionProviderId;
      conversationJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      expectedAgentSessionId?: string;
      expectedAgentSessionResetAt?: string | null;
      accessFingerprint?: string;
    },
  ): Promise<boolean> {
    return this.sessions.setSession(agentFolder, sessionId, threadId, {
      appId: metadata.appId,
      executionProviderId: metadata.executionProviderId,
      chatJid: metadata.conversationJid,
      conversationKind: metadata.conversationKind,
      memoryUserId: metadata.memoryUserId,
      expectedAgentSessionId: metadata.expectedAgentSessionId,
      expectedAgentSessionResetAt: metadata.expectedAgentSessionResetAt,
      accessFingerprint: metadata.accessFingerprint,
    });
  }

  async getAgentTurnContext(input: {
    appId?: string;
    agentFolder: string;
    executionProviderId: ExecutionProviderId;
    conversationJid: string;
    threadId?: string | null;
    conversationKind?: 'dm' | 'channel';
    memoryUserId?: string;
    jobId?: string;
    query?: string;
    hydrateMemory?: boolean;
    hydrationMode?: 'first_visible' | 'full';
  }): Promise<{
    appId: string;
    agentId: string;
    agentSessionId: string;
    agentSessionResetAt?: string | null;
    providerSessionId?: string;
    externalSessionId?: string;
    providerSessionAccessFingerprint?: string;
    memoryContextBlock?: string;
  }> {
    return this.sessions.getAgentTurnContext({
      appId: input.appId,
      workspaceFolder: input.agentFolder,
      executionProviderId: input.executionProviderId,
      chatJid: input.conversationJid,
      threadId: input.threadId,
      conversationKind: input.conversationKind,
      memoryUserId: input.memoryUserId,
      jobId: input.jobId,
      query: input.query,
      hydrateMemory: input.hydrateMemory,
      hydrationMode: input.hydrationMode,
    });
  }

  async expireProviderSession(input: {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
  }): Promise<void> {
    await this.sessions.expireProviderSession(input);
  }

  async createSessionAgentRun(input: {
    agentSessionId: string;
    executionProviderId: ExecutionProviderId;
    providerSessionId?: string | null;
    cause: 'message' | 'job' | 'control' | 'manual';
  }): Promise<string | undefined> {
    assertSafeExecutionProviderId(input.executionProviderId);
    const repositories = createPostgresDomainRepositories(this.db, this.pool);
    const session = await repositories.agentSessions.getAgentSession(
      input.agentSessionId as never,
    );
    if (!session) return undefined;
    const runId = `agent-run:${randomUUID()}`;
    const now = nowIso();
    const jobId = input.cause === 'job' ? undefined : session.jobId;
    await repositories.agentRuns.saveAgentRun({
      id: runId,
      appId: session.appId,
      agentId: session.agentId,
      configVersionId: configVersionIdForAgent(session.agentId),
      sessionId: session.id,
      conversationId: session.conversationId,
      threadId: session.threadId,
      jobId,
      llmProfileId: DEFAULT_LLM_PROFILE_ID,
      executionProviderId: input.executionProviderId,
      providerSessionId: input.providerSessionId ?? undefined,
      permissionDecisionIds: [],
      cause: input.cause,
      status: 'running',
      createdAt: now,
      startedAt: now,
    } as never);
    await this.options.runtimeEvents.publish({
      appId: session.appId,
      runId: runId as never,
      sessionId: session.id,
      eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
      actor: 'runtime',
      // Resolved-run diagnostics for the live lane: the inherited agent engine
      // (derived from the diagnostic executionProviderId) and the diagnostic id
      // itself. No secrets. The DB-layer emit does not have the modelAlias /
      // sandbox provider at this point; those live on the scheduled-lane payload.
      payload: {
        cause: input.cause,
        agent_engine:
          engineForExecutionProviderId(input.executionProviderId) ?? null,
        execution_provider_id: input.executionProviderId,
      },
      createdAt: now,
    });
    return runId;
  }

  async updateAgentRunProviderMetadata(input: {
    runId: string;
    runIds?: string[];
    fenceRunId?: string;
    leaseToken?: string;
    workerInstanceId?: string;
    fencingVersion?: number;
    providerRunId?: string | null;
    providerSessionId?: string | null;
  }): Promise<boolean> {
    return this.jobs.updateAgentRunProviderMetadata(input);
  }

  async completeSessionAgentRun(input: {
    runId: string;
    status: 'completed' | 'failed' | 'canceled';
    resultSummary?: string | null;
    errorSummary?: string | null;
  }): Promise<void> {
    const repositories = createPostgresDomainRepositories(this.db, this.pool);
    const run = await repositories.agentRuns.getAgentRun(input.runId as never);
    if (!run) return;
    const resultSummary =
      input.resultSummary == null
        ? input.resultSummary
        : redactProviderSessionHandlesInText(input.resultSummary);
    const errorSummary =
      input.errorSummary == null
        ? input.errorSummary
        : redactProviderSessionHandlesInText(input.errorSummary);
    const now = nowIso();
    await repositories.agentRuns.saveAgentRun({
      ...run,
      status: input.status,
      endedAt: now,
      resultSummary: resultSummary ?? run.resultSummary,
      errorSummary: errorSummary ?? run.errorSummary,
    });
    await this.options.runtimeEvents.publish({
      appId: run.appId,
      runId: run.id,
      sessionId: run.sessionId,
      eventType:
        input.status === 'completed'
          ? RUNTIME_EVENT_TYPES.RUN_COMPLETED
          : input.status === 'failed'
            ? RUNTIME_EVENT_TYPES.RUN_FAILED
            : RUNTIME_EVENT_TYPES.RUN_CANCELED,
      actor: 'runtime',
      payload: {
        resultSummary: resultSummary ?? null,
        errorSummary: errorSummary ?? null,
      },
      createdAt: now,
    });
  }

  async deleteSession(
    agentFolder: string,
    threadId?: string | null,
    metadata: {
      appId?: string;
      conversationJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
      agentId?: string;
    } = {},
  ): Promise<void> {
    await this.sessions.deleteSession(agentFolder, threadId, {
      appId: metadata.appId,
      chatJid: metadata.conversationJid,
      conversationKind: metadata.conversationKind,
      memoryUserId: metadata.memoryUserId,
      agentId: metadata.agentId,
    });
  }

  async deleteSessionsByAgentFolder(agentFolder: string): Promise<void> {
    await this.sessions.deleteSessionsByWorkspaceFolder(agentFolder);
  }

  async getConversationRoute(
    jid: string,
  ): Promise<ConversationRoute | undefined> {
    return this.bindings.getConversationRoute(jid);
  }

  async setConversationRoute(
    jid: string,
    group: ConversationRoute,
  ): Promise<void> {
    await this.bindings.setConversationRoute(jid, group);
  }

  async deleteConversationRoute(jid: string): Promise<void> {
    await this.bindings.deleteConversationRoute(jid);
  }

  async getAllConversationRoutes(): Promise<Record<string, ConversationRoute>> {
    return this.bindings.getAllConversationRoutes();
  }
}
