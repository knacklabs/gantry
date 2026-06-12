// prettier-ignore
import type { Job, JobAccessRequirement, JobCapabilityRequirement, JobCapabilityRequirementImplementation, JobEvent, JobRun } from '../../../../domain/repositories/domain-types.js';
import type {
  JobEventListFilters,
  JobListFilters,
  JobRunListFilters,
  JobUpsertInput,
  ReleasedStaleJobLease,
} from '../../../../domain/repositories/ops-repo.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import {
  CANONICAL_APP_ID,
  agentIdForFolder,
  json,
  parseJson,
} from '../repositories/canonical-graph-repository.postgres.js';
import { assertSafeExecutionProviderId } from '../../../../domain/sessions/execution-provider-id.js';
import type { RunLease } from '../../../../domain/ports/worker-coordination.js';
import type { ExecutionProviderId } from '../../../../domain/sessions/sessions.js';
// prettier-ignore
import type { CanonicalJobEventRecord, CanonicalJobRecord, CanonicalRunRecord, JobRecordInput, PostgresCanonicalJobRepository } from '../repositories/canonical-job-repository.postgres.js';
import { redactProviderSessionHandlesInText } from '../../../../shared/provider-session-redaction.js';
import {
  parseRecoveryIntent,
  parseRequiredCapabilities,
  parseSetupState,
} from './canonical-job-target-state.js';

type JobRecordSource = Omit<JobUpsertInput, 'id'> | JobUpsertInput | Job;
type CanonicalExecutionContext = NonNullable<Job['execution_context']>;
type CanonicalNotificationRoute = NonNullable<
  Job['notification_routes']
>[number];

export class CanonicalJobOpsService {
  constructor(private readonly repository: PostgresCanonicalJobRepository) {}

  async upsertJob(job: JobUpsertInput): Promise<{ created: boolean }> {
    const now = currentIso();
    const existing = await this.getJobById(job.id);
    const status =
      existing?.status === 'running' || existing?.status === 'dead_lettered'
        ? existing.status
        : job.status || 'active';
    await this.repository.upsertJob(
      this.toRecordInput(job.id, agentIdForFolder(job.workspace_key), {
        name: job.name,
        prompt: job.prompt,
        model: job.model,
        schedule_type: job.schedule_type,
        schedule_value: job.schedule_value,
        status,
        session_id: job.session_id,
        thread_id: job.thread_id,
        workspace_key: job.workspace_key,
        created_by: job.created_by,
        cleanup_after_ms: job.cleanup_after_ms,
        timeout_ms: job.timeout_ms,
        max_retries: job.max_retries,
        retry_backoff_ms: job.retry_backoff_ms,
        max_consecutive_failures: job.max_consecutive_failures,
        consecutive_failures: job.consecutive_failures,
        lease_run_id: job.lease_run_id,
        lease_expires_at: job.lease_expires_at,
        next_run: job.next_run,
        last_run: job.last_run,
        silent: job.silent,
        pause_reason: job.pause_reason,
        execution_context: job.execution_context,
        notification_routes: job.notification_routes,
        access_requirements: job.access_requirements,
        setup_state: job.setup_state,
        recovery_intent: job.recovery_intent,
        created_at: job.created_at || now,
        updated_at: job.updated_at || now,
      }),
    );
    return { created: !existing };
  }

  async getJobById(id: string): Promise<Job | undefined> {
    const row = await this.repository.findJobById(id);
    return row ? this.rowToJob(row) : undefined;
  }

  async getAllJobs(): Promise<Job[]> {
    const rows = await this.repository.listJobs();
    return rows.map((row) => this.rowToJob(row));
  }

  async listJobs(filters?: JobListFilters): Promise<Job[]> {
    const rows = await this.repository.listJobs(filters);
    return rows.map((row) => this.rowToJob(row));
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    const current = await this.getJobById(id);
    if (!current) return;
    const next = { ...current, ...updates };
    await this.repository.updateJob(
      id,
      this.toRecordInput(id, agentIdForFolder(next.workspace_key), {
        ...next,
        updated_at: updates.updated_at ?? currentIso(),
      }),
    );
  }

  async deleteJob(id: string): Promise<void> {
    await this.repository.deleteJob(id);
  }

  async deleteExpiredCompletedOneTimeJobs(
    nowIso: string = currentIso(),
  ): Promise<number> {
    const nowMs = Date.parse(nowIso);
    const jobs = await this.getAllJobs();
    const expired = jobs.filter((job) => {
      if (
        job.schedule_type !== 'once' ||
        !['completed', 'dead_lettered'].includes(job.status)
      ) {
        return false;
      }
      const basis = Date.parse(
        job.last_run || job.updated_at || job.created_at,
      );
      return (
        job.cleanup_after_ms === 0 || nowMs - basis >= job.cleanup_after_ms
      );
    });
    for (const job of expired) await this.deleteJob(job.id);
    return expired.length;
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
    assertSafeExecutionProviderId(input.executionProviderId);
    return this.repository.claimDueRunStart({
      workerInstanceId: input.workerInstanceId,
      jobId: input.jobId,
      run: {
        run_id: input.runId,
        job_id: input.jobId,
        execution_provider_id: input.executionProviderId,
        provider_run_id: null,
        provider_session_id: null,
        worker_id: input.workerId ?? null,
        lease_owner: input.leaseOwner ?? null,
        lease_expires_at: input.leaseExpiresAt,
        scheduled_for: input.scheduledFor,
        started_at: input.startedAt,
        ended_at: null,
        status: 'running',
        result_summary: null,
        error_summary: null,
        retry_count: input.retryCount,
        notified_at: null,
      },
      leaseExpiresAt: input.leaseExpiresAt,
      requireNextRun: input.requireNextRun,
    });
  }

  async releaseStaleJobLeases(
    nowIso: string = currentIso(),
  ): Promise<ReleasedStaleJobLease[]> {
    return this.repository.releaseStaleLeases(nowIso);
  }

  async settleJobRunLease(input: {
    runId: string;
    leaseToken: string;
    outcome: 'completed' | 'failed' | 'released';
    allowAlreadySettled?: boolean;
  }): Promise<boolean> {
    return this.repository.settleRunLease(input);
  }

  async createJobRun(run: JobRun): Promise<boolean> {
    assertSafeExecutionProviderId(run.execution_provider_id);
    return this.repository.insertRun(run);
  }

  // prettier-ignore
  async updateAgentRunProviderMetadata(input: { runId: string; runIds?: string[]; fenceRunId?: string; leaseToken?: string; workerInstanceId?: string; fencingVersion?: number; providerRunId?: string | null; providerSessionId?: string | null }): Promise<boolean> {
    return this.repository.updateRunProviderMetadata(input.runIds ?? input.runId, { fenceRunId: input.fenceRunId, leaseToken: input.leaseToken, workerInstanceId: input.workerInstanceId, fencingVersion: input.fencingVersion, providerRunId: input.providerRunId, providerSessionId: input.providerSessionId });
  }

  async getRecentJobRuns(limit = 200): Promise<JobRun[]> {
    return this.listJobRuns(undefined, limit);
  }

  async completeJobRun(
    runId: string,
    status: JobRun['status'],
    resultSummary: string | null = null,
    errorSummary: string | null = null,
  ): Promise<void> {
    const redactedResultSummary =
      resultSummary == null
        ? resultSummary
        : redactProviderSessionHandlesInText(resultSummary);
    const redactedErrorSummary =
      errorSummary == null
        ? errorSummary
        : redactProviderSessionHandlesInText(errorSummary);
    await this.repository.updateRunCompletion(runId, {
      status,
      endedAt: currentIso(),
      resultSummary: redactedResultSummary,
      errorSummary: redactedErrorSummary,
    });
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
    const redactedResultSummary =
      input.resultSummary == null
        ? (input.resultSummary ?? null)
        : redactProviderSessionHandlesInText(input.resultSummary);
    const redactedErrorSummary =
      input.errorSummary == null
        ? (input.errorSummary ?? null)
        : redactProviderSessionHandlesInText(input.errorSummary);
    return this.repository.updateRunCompletionWithLease(input.runId, {
      leaseToken: input.leaseToken,
      workerInstanceId: input.workerInstanceId,
      fencingVersion: input.fencingVersion,
      status: input.status,
      endedAt: currentIso(),
      resultSummary: redactedResultSummary,
      errorSummary: redactedErrorSummary,
    });
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
    const redactedResultSummary =
      input.resultSummary == null
        ? (input.resultSummary ?? null)
        : redactProviderSessionHandlesInText(input.resultSummary);
    const redactedErrorSummary =
      input.errorSummary == null
        ? (input.errorSummary ?? null)
        : redactProviderSessionHandlesInText(input.errorSummary);
    return this.repository.finalizeRunCompletionWithLease({
      runId: input.runId,
      leaseToken: input.leaseToken,
      workerInstanceId: input.workerInstanceId,
      fencingVersion: input.fencingVersion,
      leaseOutcome: input.leaseOutcome,
      runCompletion: {
        status: input.runStatus,
        endedAt: currentIso(),
        resultSummary: redactedResultSummary,
        errorSummary: redactedErrorSummary,
      },
    });
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
    const redactedResultSummary =
      input.resultSummary == null
        ? (input.resultSummary ?? null)
        : redactProviderSessionHandlesInText(input.resultSummary);
    const redactedErrorSummary =
      input.errorSummary == null
        ? (input.errorSummary ?? null)
        : redactProviderSessionHandlesInText(input.errorSummary);
    return this.repository.finalizeRunWithLease({
      jobId: input.jobId,
      runId: input.runId,
      leaseToken: input.leaseToken,
      workerInstanceId: input.workerInstanceId,
      fencingVersion: input.fencingVersion,
      leaseOutcome: input.leaseOutcome,
      runCompletion: {
        status: input.runStatus,
        endedAt: currentIso(),
        resultSummary: redactedResultSummary,
        errorSummary: redactedErrorSummary,
      },
      jobUpdate: this.toTerminalJobUpdate(input.jobUpdates),
    });
  }

  async markJobRunNotified(
    runId: string,
    lease?: {
      leaseToken: string;
      workerInstanceId: string;
      fencingVersion: number;
    },
  ): Promise<boolean> {
    return this.repository.markRunNotified(runId, currentIso(), lease);
  }

  async getJobRunById(runId: string): Promise<JobRun | undefined> {
    const row = await this.repository.findRunById(runId);
    return row ? this.mapRun(row) : undefined;
  }

  async listJobRuns(
    jobId?: string,
    limit = 50,
    filters?: JobRunListFilters,
  ): Promise<JobRun[]> {
    if (!jobId && filters?.jobIds?.length === 0) return [];
    const rows = await this.repository.listRuns(jobId, limit, filters);
    return rows.map((row) => this.mapRun(row));
  }

  async listDeadLetterRuns(limit = 50): Promise<JobRun[]> {
    const rows = await this.repository.listDeadLetterRuns(limit);
    return rows.map((row) => this.mapRun(row));
  }

  async listRecentJobEvents(
    limit = 200,
    filters?: JobEventListFilters,
  ): Promise<JobEvent[]> {
    if (!filters?.job_id && filters?.job_ids?.length === 0) return [];
    const appId = await this.resolveEventQueryAppId(filters);
    const rows = await this.repository.listEvents(limit, {
      appId,
      ownerAppId: filters?.owner_app_id,
      jobId: filters?.job_id,
      jobIds: filters?.job_ids,
      runId: filters?.run_id,
      eventType: filters?.event_type,
      sinceId: filters?.since_id,
      since: filters?.since,
    });
    return rows.map((row, index) => this.mapEvent(row, index, filters?.job_id));
  }

  private async resolveEventQueryAppId(filters?: {
    app_id?: string;
    job_id?: string;
    job_ids?: string[];
    owner_app_id?: string;
    run_id?: string;
  }): Promise<string | undefined> {
    if (filters?.app_id) return filters.app_id;
    if (filters?.owner_app_id || filters?.job_ids?.length) return undefined;
    if (filters?.run_id) {
      const eventAppId = await this.repository.findRuntimeEventAppIdForRun(
        filters.run_id,
      );
      if (eventAppId) return eventAppId;
    }

    const jobId =
      filters?.job_id ??
      (filters?.run_id
        ? (await this.repository.findRunById(filters.run_id))?.jobId
        : undefined);
    if (!jobId) return CANONICAL_APP_ID;

    return CANONICAL_APP_ID;
  }

  private rowToJob(row: CanonicalJobRecord): Job {
    const schedule = parseJson<{ type?: string; value?: string }>(
      row.scheduleJson,
      {},
    );
    const target = parseJson<Record<string, unknown>>(row.targetJson, {});
    const executionContext = parseExecutionContext(target.executionContext) ?? {
      conversationJid: '',
      threadId: null,
      workspaceKey: row.agentId?.replace(/^agent:/, '') || 'system',
      sessionId: null,
    };
    const notificationRoutes = resolveNotificationRoutesFromTarget({
      targetRoutes: target.notificationRoutes,
      executionContext,
    });
    const accessRequirements = parseAccessRequirements(
      target.accessRequirements,
    );
    const setupState = parseSetupState(target.setupState);
    const recoveryIntent = parseRecoveryIntent(target.recoveryIntent);
    const requiredCapabilities = parseRequiredCapabilities(
      target.requiredCapabilities,
    );
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      model: row.model,
      schedule_type: (schedule.type as Job['schedule_type']) || 'manual',
      schedule_value: schedule.value || '',
      status: row.status as Job['status'],
      session_id: executionContext.sessionId ?? null,
      thread_id: executionContext.threadId ?? null,
      workspace_key: executionContext.workspaceKey,
      created_by: (target.createdBy as Job['created_by']) || 'agent',
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      next_run: row.nextRunAt,
      last_run: row.lastRunAt,
      silent: row.silent,
      cleanup_after_ms: Number(target.cleanupAfterMs ?? 86400000),
      timeout_ms: row.timeoutMs,
      max_retries: row.maxRetries,
      retry_backoff_ms: row.retryBackoffMs,
      max_consecutive_failures: Number(target.maxConsecutiveFailures ?? 5),
      consecutive_failures: Number(target.consecutiveFailures ?? 0),
      lease_run_id: row.leaseRunId,
      lease_expires_at: row.leaseExpiresAt,
      pause_reason: (target.pauseReason as string | null | undefined) ?? null,
      execution_context: executionContext,
      notification_routes: notificationRoutes,
      access_requirements: accessRequirements,
      setup_state: setupState,
      recovery_intent: recoveryIntent,
      required_capabilities: requiredCapabilities,
    };
  }

  private toRecordInput(
    id: string,
    agentId: string,
    job: JobRecordSource,
  ): JobRecordInput {
    const now = currentIso();
    const executionContext = mergeExecutionContextSessionId(
      resolveExecutionContext(job, agentId),
      job.session_id,
    );
    const notificationRoutes = resolveNotificationRoutes(job, executionContext);
    return {
      id,
      agentId,
      name: job.name,
      prompt: job.prompt,
      model: job.model || null,
      scheduleJson: json({
        type: job.schedule_type,
        value: job.schedule_value,
      }),
      status: job.status || 'active',
      targetJson: json({
        executionContext,
        notificationRoutes,
        createdBy: job.created_by || 'agent',
        cleanupAfterMs: job.cleanup_after_ms ?? 86400000,
        maxConsecutiveFailures: job.max_consecutive_failures ?? 5,
        consecutiveFailures: job.consecutive_failures ?? 0,
        pauseReason: job.pause_reason ?? null,
        accessRequirements: parseAccessRequirements(job.access_requirements),
        setupState: parseSetupState(job.setup_state),
        recoveryIntent: parseRecoveryIntent(job.recovery_intent),
        requiredCapabilities: parseRequiredCapabilities(
          job.required_capabilities,
        ),
      }),
      silent: Boolean(job.silent),
      timeoutMs: job.timeout_ms ?? 300000,
      maxRetries: job.max_retries ?? 3,
      retryBackoffMs: job.retry_backoff_ms ?? 5000,
      nextRunAt: job.next_run ?? null,
      lastRunAt: job.last_run ?? null,
      leaseRunId: job.lease_run_id ?? null,
      leaseExpiresAt: job.lease_expires_at ?? null,
      createdAt: job.created_at || now,
      updatedAt: job.updated_at || now,
    };
  }

  private toTerminalJobUpdate(job: Partial<Job>) {
    const targetJsonPatch: Record<string, unknown> = {};
    if (job.consecutive_failures !== undefined) {
      targetJsonPatch.consecutiveFailures = job.consecutive_failures;
    }
    if (job.pause_reason !== undefined) {
      targetJsonPatch.pauseReason = job.pause_reason;
    }
    if (job.setup_state !== undefined) {
      targetJsonPatch.setupState = parseSetupState(job.setup_state);
    }
    if (job.recovery_intent !== undefined) {
      targetJsonPatch.recoveryIntent = parseRecoveryIntent(job.recovery_intent);
    }
    if (job.max_consecutive_failures !== undefined) {
      targetJsonPatch.maxConsecutiveFailures = job.max_consecutive_failures;
    }
    return {
      ...(job.status !== undefined ? { status: job.status } : {}),
      ...(job.next_run !== undefined ? { nextRunAt: job.next_run } : {}),
      ...(job.last_run !== undefined ? { lastRunAt: job.last_run } : {}),
      ...(job.lease_run_id !== undefined
        ? { leaseRunId: job.lease_run_id }
        : {}),
      ...(job.lease_expires_at !== undefined
        ? { leaseExpiresAt: job.lease_expires_at }
        : {}),
      updatedAt: job.updated_at ?? currentIso(),
      ...(Object.keys(targetJsonPatch).length > 0 ? { targetJsonPatch } : {}),
    };
  }

  private mapRun(row: CanonicalRunRecord): JobRun {
    return {
      run_id: row.id,
      short_id: row.shortId,
      job_id: row.jobId || '',
      execution_provider_id: row.executionProviderId as ExecutionProviderId,
      provider_run_id: row.providerRunId,
      provider_session_id: row.providerSessionId,
      worker_id: row.workerId,
      lease_owner: row.leaseOwner,
      lease_expires_at: row.leaseExpiresAt,
      scheduled_for: row.createdAt,
      started_at: row.startedAt || row.createdAt,
      ended_at: row.endedAt,
      status: row.status as JobRun['status'],
      result_summary: row.resultSummary,
      error_summary: row.errorSummary,
      retry_count: 0,
      notified_at: row.notifiedAt,
    };
  }

  private mapEvent(
    row: CanonicalJobEventRecord,
    index: number,
    fallbackJobId?: string,
  ): JobEvent {
    const payload = parseJson<Partial<JobEvent>>(row.payloadJson, {});
    return {
      id: Number(row.id) || index + 1,
      job_id: row.jobId || payload.job_id || fallbackJobId || '',
      run_id: row.runId,
      event_type: row.type,
      payload: payload.payload ?? row.payloadJson,
      created_at: row.createdAt,
    };
  }
}

function parseExecutionContext(
  input: unknown,
): CanonicalExecutionContext | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const conversationJid = normalizeString(value.conversationJid);
  const workspaceKey = normalizeString(value.workspaceKey);
  if (!conversationJid || !workspaceKey) return undefined;
  return {
    conversationJid,
    threadId: normalizeNullableString(value.threadId),
    workspaceKey,
    sessionId: normalizeNullableString(value.sessionId),
  };
}

function parseNotificationRoutes(input: unknown): CanonicalNotificationRoute[] {
  if (!Array.isArray(input)) return [];
  const routes: CanonicalNotificationRoute[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const conversationJid = normalizeString(value.conversationJid);
    const label = normalizeString(value.label);
    if (!conversationJid || !label) continue;
    routes.push({
      conversationJid,
      threadId: normalizeNullableString(value.threadId),
      label,
    });
  }
  return routes;
}

function parseToolAccessRequirements(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean),
    ),
  ];
}

function parseAccessRequirements(input: unknown): JobAccessRequirement[] {
  if (!Array.isArray(input)) return [];
  const out: JobAccessRequirement[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const targetRaw = record.target;
    if (
      !targetRaw ||
      typeof targetRaw !== 'object' ||
      Array.isArray(targetRaw)
    ) {
      continue;
    }
    const target = targetRaw as Record<string, unknown>;
    const kind = normalizeString(target.kind);
    const reason = normalizeString(record.reason);
    let normalized: JobAccessRequirement | undefined;
    let key: string;
    if (kind === 'tool_rule') {
      const rule = normalizeString(target.rule);
      if (!rule) continue;
      normalized = { target: { kind: 'tool_rule', rule } };
      key = `tool_rule ${rule}`;
    } else if (kind === 'capability') {
      const capabilityId = normalizeString(
        target.capabilityId ?? target.capability_id,
      );
      if (!capabilityId) continue;
      const implementation = parseCapabilityImplementation(
        target.implementation,
      );
      normalized = {
        target: {
          kind: 'capability',
          capabilityId,
          ...(implementation ? { implementation } : {}),
        },
      };
      key = `capability ${capabilityId} ${implementation?.kind ?? ''} ${implementation?.name ?? ''}`;
    } else if (kind === 'mcp_server') {
      const server = normalizeString(target.server);
      if (!server) continue;
      normalized = { target: { kind: 'mcp_server', server } };
      key = `mcp_server ${server}`;
    } else {
      continue;
    }
    if (reason) normalized.reason = reason;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function parseCapabilityImplementation(
  input: unknown,
): JobCapabilityRequirementImplementation | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const kind = normalizeString(record.kind);
  if (
    kind !== 'configured_access' &&
    kind !== 'local_cli' &&
    kind !== 'mcp_server' &&
    kind !== 'builtin_tool'
  ) {
    return undefined;
  }
  const implementation: JobCapabilityRequirementImplementation = { kind };
  const name = normalizeString(record.name);
  if (name) implementation.name = name;
  const executablePath = normalizeString(
    record.executablePath ?? record.executable_path,
  );
  if (executablePath) implementation.executablePath = executablePath;
  const executableVersion = normalizeString(
    record.executableVersion ?? record.executable_version,
  );
  if (executableVersion) implementation.executableVersion = executableVersion;
  const executableHash = normalizeString(
    record.executableHash ?? record.executable_hash,
  );
  if (executableHash) implementation.executableHash = executableHash;
  const commandTemplate = normalizeString(
    record.commandTemplate ?? record.command_template,
  );
  if (commandTemplate) implementation.commandTemplate = commandTemplate;
  const authPreflight = normalizeString(
    record.authPreflight ?? record.auth_preflight,
  );
  if (authPreflight) implementation.authPreflight = authPreflight;
  const protectedPaths = parseToolAccessRequirements(
    record.protectedPaths ?? record.protected_paths,
  );
  if (protectedPaths.length > 0) implementation.protectedPaths = protectedPaths;
  const networkHosts = parseToolAccessRequirements(
    record.networkHosts ?? record.network_hosts,
  );
  if (networkHosts.length > 0) implementation.networkHosts = networkHosts;
  return implementation;
}

function resolveExecutionContext(
  job: JobRecordSource,
  agentId: string,
): CanonicalExecutionContext {
  const parsed = parseExecutionContext(job.execution_context);
  if (parsed) return parsed;

  const firstRouteConversation = parseNotificationRoutes(
    job.notification_routes,
  )[0]?.conversationJid;
  const fallbackConversation = normalizeString(firstRouteConversation);
  if (!fallbackConversation) {
    throw new Error(
      `Job ${'id' in job ? String(job.id) : '<unknown>'} is missing execution context conversation.`,
    );
  }
  return {
    conversationJid: fallbackConversation,
    threadId: normalizeNullableString(job.thread_id),
    workspaceKey:
      normalizeString(job.workspace_key) ?? agentId.replace(/^agent:/, ''),
    sessionId: normalizeNullableString(job.session_id),
  };
}

function mergeExecutionContextSessionId(
  executionContext: CanonicalExecutionContext,
  sessionId: unknown,
): CanonicalExecutionContext {
  const fallback = normalizeNullableString(sessionId);
  return executionContext.sessionId || !fallback
    ? executionContext
    : { ...executionContext, sessionId: fallback };
}

function resolveNotificationRoutes(
  job: JobRecordSource,
  executionContext: CanonicalExecutionContext,
): CanonicalNotificationRoute[] {
  const explicitRoutes = parseNotificationRoutes(job.notification_routes);
  if (explicitRoutes.length > 0) return explicitRoutes;

  return [
    {
      conversationJid: executionContext.conversationJid,
      threadId: executionContext.threadId,
      label: 'Primary',
    },
  ];
}

function normalizeString(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveNotificationRoutesFromTarget(input: {
  targetRoutes: unknown;
  executionContext: CanonicalExecutionContext;
}): CanonicalNotificationRoute[] {
  const explicitRoutes = parseNotificationRoutes(input.targetRoutes);
  if (explicitRoutes.length > 0) return explicitRoutes;
  if (!input.executionContext.conversationJid) return [];
  return [
    {
      conversationJid: input.executionContext.conversationJid,
      threadId: input.executionContext.threadId,
      label: 'Primary',
    },
  ];
}

// prettier-ignore
function normalizeNullableString(input: unknown): string | null { return input === null || input === undefined ? null : (normalizeString(input) ?? null); }
