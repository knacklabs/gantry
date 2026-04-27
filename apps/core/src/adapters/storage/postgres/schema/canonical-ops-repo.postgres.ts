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
  PostgresCanonicalGraphRepository,
} from '../repositories/canonical-graph-repository.postgres.js';
import { PostgresCanonicalJobRepository } from '../repositories/canonical-job-repository.postgres.js';
import { PostgresCanonicalMessageRepository } from '../repositories/canonical-message-repository.postgres.js';
import { PostgresCanonicalRouterStateRepository } from '../repositories/canonical-router-state-repository.postgres.js';
import { PostgresCanonicalSessionRepository } from '../repositories/canonical-session-repository.postgres.js';
import { CanonicalBindingOpsService } from '../services/canonical-binding-ops-service.js';
import { CanonicalJobOpsService } from '../services/canonical-job-ops-service.js';
import { CanonicalMessageOpsService } from '../services/canonical-message-ops-service.js';
import { CanonicalSessionOpsService } from '../services/canonical-session-ops-service.js';

export class PostgresCanonicalOpsRepository implements OpsRepository {
  private readonly graph: PostgresCanonicalGraphRepository;
  private readonly messages: CanonicalMessageOpsService;
  private readonly jobs: CanonicalJobOpsService;
  private readonly sessions: CanonicalSessionOpsService;
  private readonly bindings: CanonicalBindingOpsService;
  private readonly routerState: PostgresCanonicalRouterStateRepository;

  constructor(
    private readonly pool: Pool,
    db: CanonicalDb,
  ) {
    this.graph = new PostgresCanonicalGraphRepository(db);
    this.messages = new CanonicalMessageOpsService(
      new PostgresCanonicalMessageRepository(db),
    );
    this.jobs = new CanonicalJobOpsService(
      new PostgresCanonicalJobRepository(db),
    );
    this.sessions = new CanonicalSessionOpsService(
      new PostgresCanonicalSessionRepository(db),
    );
    this.bindings = new CanonicalBindingOpsService(
      new PostgresCanonicalBindingRepository(db),
    );
    this.routerState = new PostgresCanonicalRouterStateRepository(db);
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
  ): Promise<void> {
    await this.sessions.setSession(groupFolder, sessionId, threadId);
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
