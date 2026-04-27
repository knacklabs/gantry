import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  ChatInfo,
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  RegisteredGroup,
} from '../../../../domain/repositories/domain-types.js';
import type {
  JobUpsertInput,
  OpsRepository,
} from '../../../../domain/repositories/ops-repo.js';
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
import { CanonicalBindingOpsService } from '../services/canonical-binding-ops-service.js';
import { CanonicalJobOpsService } from '../services/canonical-job-ops-service.js';
import { CanonicalMessageOpsService } from '../services/canonical-message-ops-service.js';
import { CanonicalSessionOpsService } from '../services/canonical-session-ops-service.js';

interface SessionRuntimeOptions {
  recentMessageLimit?: number;
  summaryAfterMessages?: number;
  summaryAfterRuns?: number;
  maxHydratedContextChars?: number;
}

export class PostgresCanonicalOpsRepository implements OpsRepository {
  private readonly graph: PostgresCanonicalGraphRepository;
  private readonly messages: CanonicalMessageOpsService;
  private readonly jobs: CanonicalJobOpsService;
  private readonly sessions: CanonicalSessionOpsService;
  private readonly bindings: CanonicalBindingOpsService;
  private readonly routerState: PostgresCanonicalRouterStateRepository;

  constructor(
    private readonly pool: Pool,
    private readonly db: CanonicalDb,
    options: { sessions?: SessionRuntimeOptions } = {},
  ) {
    this.graph = new PostgresCanonicalGraphRepository(this.db);
    this.messages = new CanonicalMessageOpsService(
      new PostgresCanonicalMessageRepository(this.db),
    );
    this.jobs = new CanonicalJobOpsService(
      new PostgresCanonicalJobRepository(this.db),
    );
    this.sessions = new CanonicalSessionOpsService(
      new PostgresCanonicalSessionRepository(this.db),
      createPostgresDomainRepositories(this.db),
      options.sessions,
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
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean> {
    return this.jobs.claimDueJobRunStart(input);
  }

  async releaseStaleJobLeases(nowIso?: string): Promise<number> {
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

  async markJobRunNotified(runId: string): Promise<void> {
    await this.jobs.markJobRunNotified(runId);
  }

  async getJobRunById(runId: string): Promise<JobRun | undefined> {
    return this.jobs.getJobRunById(runId);
  }

  async listJobRuns(jobId?: string, limit = 50): Promise<JobRun[]> {
    return this.jobs.listJobRuns(jobId, limit);
  }

  async listDeadLetterRuns(limit = 50): Promise<JobRun[]> {
    return this.jobs.listDeadLetterRuns(limit);
  }

  async addJobEvent(event: Omit<JobEvent, 'id'>): Promise<void> {
    await this.jobs.addJobEvent(event);
  }

  async listRecentJobEvents(
    limit = 200,
    filters?: { job_id?: string; run_id?: string; event_type?: string },
  ): Promise<JobEvent[]> {
    return this.jobs.listRecentJobEvents(limit, filters);
  }

  async getRouterState(key: string): Promise<string | undefined> {
    return this.routerState.get(key);
  }

  async setRouterState(key: string, value: string): Promise<void> {
    await this.routerState.set(key, value);
  }

  async getSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<string | undefined> {
    return this.sessions.getSession(groupFolder, threadId);
  }

  async setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
    metadata: { chatJid?: string; artifactRef?: string | null } = {},
  ): Promise<void> {
    await this.sessions.setSession(groupFolder, sessionId, threadId, metadata);
  }

  async getSessionResume(input: {
    groupFolder: string;
    chatJid: string;
    threadId?: string | null;
  }): Promise<{
    agentSessionId: string;
    mode: 'provider_native' | 'db_replay';
    providerSessionId?: string;
    externalSessionId?: string;
    hydratedContextBlock?: string;
  }> {
    return this.sessions.getSessionResume(input);
  }

  async expireProviderSession(input: {
    providerSessionId?: string;
    agentSessionId?: string;
    provider?: string;
    externalSessionId?: string;
  }): Promise<void> {
    await this.sessions.expireProviderSession(input);
  }

  async checkpointSessionSummary(agentSessionId: string): Promise<void> {
    await this.sessions.checkpointSessionSummary(agentSessionId);
  }

  async createSessionAgentRun(input: {
    agentSessionId: string;
    cause: 'message' | 'job' | 'control' | 'manual';
  }): Promise<string | undefined> {
    const repositories = createPostgresDomainRepositories(this.db);
    const session = await repositories.agentSessions.getAgentSession(
      input.agentSessionId as never,
    );
    if (!session) return undefined;
    const runId = `agent-run:${randomUUID()}`;
    const now = new Date().toISOString();
    await repositories.agentRuns.saveAgentRun({
      id: runId,
      appId: session.appId,
      agentId: session.agentId,
      configVersionId: configVersionIdForAgent(session.agentId),
      sessionId: session.id,
      conversationId: session.conversationId,
      threadId: session.threadId,
      jobId: session.jobId,
      llmProfileId: DEFAULT_LLM_PROFILE_ID,
      permissionDecisionIds: [],
      cause: input.cause,
      status: 'running',
      createdAt: now,
      startedAt: now,
    } as never);
    await repositories.agentRuns.appendAgentRunEvent({
      id: `agent-run-event:${randomUUID()}` as never,
      appId: session.appId,
      runId: runId as never,
      type: 'started',
      payload: { cause: input.cause },
      createdAt: now,
    });
    return runId;
  }

  async completeSessionAgentRun(input: {
    runId: string;
    status: 'completed' | 'failed' | 'canceled';
    resultSummary?: string | null;
    errorSummary?: string | null;
  }): Promise<void> {
    const repositories = createPostgresDomainRepositories(this.db);
    const run = await repositories.agentRuns.getAgentRun(input.runId as never);
    if (!run) return;
    const now = new Date().toISOString();
    await repositories.agentRuns.saveAgentRun({
      ...run,
      status: input.status,
      endedAt: now,
      resultSummary: input.resultSummary ?? run.resultSummary,
      errorSummary: input.errorSummary ?? run.errorSummary,
    });
    await repositories.agentRuns.appendAgentRunEvent({
      id: `agent-run-event:${randomUUID()}` as never,
      appId: run.appId,
      runId: run.id,
      type: input.status,
      payload: {
        resultSummary: input.resultSummary ?? null,
        errorSummary: input.errorSummary ?? null,
      },
      createdAt: now,
    });
  }

  async deleteSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<void> {
    await this.sessions.deleteSession(groupFolder, threadId);
  }

  async deleteSessionsByGroupFolder(groupFolder: string): Promise<void> {
    await this.sessions.deleteSessionsByGroupFolder(groupFolder);
  }

  async getAllSessions(): Promise<Record<string, string>> {
    return this.sessions.getAllSessions();
  }

  async getRegisteredGroup(jid: string): Promise<RegisteredGroup | undefined> {
    return this.bindings.getRegisteredGroup(jid);
  }

  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    await this.bindings.setRegisteredGroup(jid, group);
  }

  async deleteRegisteredGroup(jid: string): Promise<void> {
    await this.bindings.deleteRegisteredGroup(jid);
  }

  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    return this.bindings.getAllRegisteredGroups();
  }
}
