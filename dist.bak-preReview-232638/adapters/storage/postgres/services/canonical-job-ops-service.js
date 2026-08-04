import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import { CANONICAL_APP_ID, agentIdForFolder, json, parseJson, } from '../repositories/canonical-graph-repository.postgres.js';
import { assertSafeExecutionProviderId } from '../../../../domain/sessions/execution-provider-id.js';
import { mapCanonicalJobEventRecord, mapCanonicalRunRecord, } from './canonical-job-record-mappers.js';
import { redactProviderSessionHandlesInText } from '../../../../shared/provider-session-redaction.js';
import { parseRecoveryIntent, parseRequiredCapabilities, parseSetupState, } from './canonical-job-target-state.js';
export class CanonicalJobOpsService {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async upsertJob(job) {
        const now = currentIso();
        const existing = await this.getJobById(job.id);
        const status = existing?.status === 'running' || existing?.status === 'dead_lettered'
            ? existing.status
            : job.status || 'active';
        await this.repository.upsertJob(this.toRecordInput(job.id, agentIdForFolder(job.workspace_key), {
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
        }));
        return { created: !existing };
    }
    async getJobById(id) {
        const row = await this.repository.findJobById(id);
        return row ? this.rowToJob(row) : undefined;
    }
    async getAllJobs() {
        const rows = await this.repository.listJobs();
        return rows.map((row) => this.rowToJob(row));
    }
    async listJobs(filters) {
        const rows = await this.repository.listJobs(filters);
        return rows.map((row) => this.rowToJob(row));
    }
    async updateJob(id, updates) {
        const current = await this.getJobById(id);
        if (!current)
            return;
        const next = { ...current, ...updates };
        await this.repository.updateJob(id, this.toRecordInput(id, agentIdForFolder(next.workspace_key), {
            ...next,
            updated_at: updates.updated_at ?? currentIso(),
        }));
    }
    async deleteJob(id) {
        await this.repository.deleteJob(id);
    }
    async deleteExpiredCompletedOneTimeJobs(nowIso = currentIso()) {
        const nowMs = Date.parse(nowIso);
        const jobs = await this.getAllJobs();
        const expired = jobs.filter((job) => {
            if (job.schedule_type !== 'once' ||
                !['completed', 'dead_lettered'].includes(job.status)) {
                return false;
            }
            const basis = Date.parse(job.last_run || job.updated_at || job.created_at);
            return (job.cleanup_after_ms === 0 || nowMs - basis >= job.cleanup_after_ms);
        });
        for (const job of expired)
            await this.deleteJob(job.id);
        return expired.length;
    }
    async claimDueJobRunStart(input) {
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
    async releaseStaleJobLeases(nowIso = currentIso()) {
        return this.repository.releaseStaleLeases(nowIso);
    }
    async settleJobRunLease(input) {
        return this.repository.settleRunLease(input);
    }
    async createJobRun(run) {
        assertSafeExecutionProviderId(run.execution_provider_id);
        return this.repository.insertRun(run);
    }
    // prettier-ignore
    async updateAgentRunProviderMetadata(input) {
        return this.repository.updateRunProviderMetadata(input.runIds ?? input.runId, { fenceRunId: input.fenceRunId, leaseToken: input.leaseToken, workerInstanceId: input.workerInstanceId, fencingVersion: input.fencingVersion, providerRunId: input.providerRunId, providerSessionId: input.providerSessionId });
    }
    async getRecentJobRuns(limit = 200) {
        return this.listJobRuns(undefined, limit);
    }
    async completeJobRun(runId, status, resultSummary = null, errorSummary = null) {
        const redactedResultSummary = resultSummary == null
            ? resultSummary
            : redactProviderSessionHandlesInText(resultSummary);
        const redactedErrorSummary = errorSummary == null
            ? errorSummary
            : redactProviderSessionHandlesInText(errorSummary);
        await this.repository.updateRunCompletion(runId, {
            status,
            endedAt: currentIso(),
            resultSummary: redactedResultSummary,
            errorSummary: redactedErrorSummary,
        });
    }
    async completeJobRunWithLease(input) {
        const redactedResultSummary = input.resultSummary == null
            ? (input.resultSummary ?? null)
            : redactProviderSessionHandlesInText(input.resultSummary);
        const redactedErrorSummary = input.errorSummary == null
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
    async finalizeJobRunLease(input) {
        const redactedResultSummary = input.resultSummary == null
            ? (input.resultSummary ?? null)
            : redactProviderSessionHandlesInText(input.resultSummary);
        const redactedErrorSummary = input.errorSummary == null
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
    async finalizeJobRunWithLease(input) {
        const redactedResultSummary = input.resultSummary == null
            ? (input.resultSummary ?? null)
            : redactProviderSessionHandlesInText(input.resultSummary);
        const redactedErrorSummary = input.errorSummary == null
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
    async markJobRunNotified(runId, lease) {
        return this.repository.markRunNotified(runId, currentIso(), lease);
    }
    async getJobRunById(runId) {
        const row = await this.repository.findRunById(runId);
        return row ? this.mapRun(row) : undefined;
    }
    async listJobRuns(jobId, limit = 50, filters) {
        if (!jobId && filters?.jobIds?.length === 0)
            return [];
        const rows = await this.repository.listRuns(jobId, limit, filters);
        return rows.map((row) => this.mapRun(row));
    }
    async listLatestJobRunsByJobIds(jobIds) {
        const rows = await this.repository.listLatestJobRunsByJobIds(jobIds);
        return new Map(rows.map((row) => [row.jobId, this.mapRun(row)]));
    }
    async listDeadLetterRuns(limit = 50) {
        const rows = await this.repository.listDeadLetterRuns(limit);
        return rows.map((row) => this.mapRun(row));
    }
    async listRecentJobEvents(limit = 200, filters) {
        if (!filters?.job_id && filters?.job_ids?.length === 0)
            return [];
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
    async resolveEventQueryAppId(filters) {
        if (filters?.app_id)
            return filters.app_id;
        if (filters?.owner_app_id || filters?.job_ids?.length)
            return undefined;
        if (filters?.run_id) {
            const eventAppId = await this.repository.findRuntimeEventAppIdForRun(filters.run_id);
            if (eventAppId)
                return eventAppId;
        }
        const jobId = filters?.job_id ??
            (filters?.run_id
                ? (await this.repository.findRunById(filters.run_id))?.jobId
                : undefined);
        if (!jobId)
            return CANONICAL_APP_ID;
        return CANONICAL_APP_ID;
    }
    rowToJob(row) {
        const schedule = parseJson(row.scheduleJson, {});
        const target = parseJson(row.targetJson, {});
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
        const accessRequirements = parseAccessRequirements(target.accessRequirements);
        const setupState = parseSetupState(target.setupState);
        const recoveryIntent = parseRecoveryIntent(target.recoveryIntent);
        const requiredCapabilities = parseRequiredCapabilities(target.requiredCapabilities);
        return {
            id: row.id,
            name: row.name,
            prompt: row.prompt,
            model: row.model,
            schedule_type: schedule.type || 'manual',
            schedule_value: schedule.value || '',
            status: row.status,
            session_id: executionContext.sessionId ?? null,
            thread_id: executionContext.threadId ?? null,
            workspace_key: executionContext.workspaceKey,
            created_by: target.createdBy || 'agent',
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
            pause_reason: target.pauseReason ?? null,
            execution_context: executionContext,
            notification_routes: notificationRoutes,
            access_requirements: accessRequirements,
            setup_state: setupState,
            recovery_intent: recoveryIntent,
            required_capabilities: requiredCapabilities,
        };
    }
    toRecordInput(id, agentId, job) {
        const now = currentIso();
        const executionContext = mergeExecutionContextSessionId(resolveExecutionContext(job, agentId), job.session_id);
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
                requiredCapabilities: parseRequiredCapabilities(job.required_capabilities),
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
    toTerminalJobUpdate(job) {
        const targetJsonPatch = {};
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
    mapRun(row) {
        return mapCanonicalRunRecord(row);
    }
    mapEvent(row, index, fallbackJobId) {
        return mapCanonicalJobEventRecord(row, index, fallbackJobId);
    }
}
function parseExecutionContext(input) {
    if (!input || typeof input !== 'object')
        return undefined;
    const value = input;
    const conversationJid = normalizeString(value.conversationJid);
    const workspaceKey = normalizeString(value.workspaceKey);
    if (!conversationJid || !workspaceKey)
        return undefined;
    return {
        conversationJid,
        threadId: normalizeNullableString(value.threadId),
        workspaceKey,
        sessionId: normalizeNullableString(value.sessionId),
    };
}
function parseNotificationRoutes(input) {
    if (!Array.isArray(input))
        return [];
    const routes = [];
    for (const item of input) {
        if (!item || typeof item !== 'object')
            continue;
        const value = item;
        const conversationJid = normalizeString(value.conversationJid);
        const label = normalizeString(value.label);
        const providerAccountId = Object.prototype.hasOwnProperty.call(value, 'providerAccountId')
            ? normalizeNullableString(value.providerAccountId)
            : undefined;
        if (!conversationJid || !label)
            continue;
        routes.push({
            conversationJid,
            threadId: normalizeNullableString(value.threadId),
            ...(providerAccountId !== undefined ? { providerAccountId } : {}),
            label,
        });
    }
    return routes;
}
function parseToolAccessRequirements(input) {
    if (!Array.isArray(input))
        return [];
    return [
        ...new Set(input
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter(Boolean)),
    ];
}
function parseAccessRequirements(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    const seen = new Set();
    for (const item of input) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const record = item;
        const targetRaw = record.target;
        if (!targetRaw ||
            typeof targetRaw !== 'object' ||
            Array.isArray(targetRaw)) {
            continue;
        }
        const target = targetRaw;
        const kind = normalizeString(target.kind);
        const reason = normalizeString(record.reason);
        let normalized;
        let key;
        if (kind === 'tool_rule') {
            const rule = normalizeString(target.rule);
            if (!rule)
                continue;
            normalized = { target: { kind: 'tool_rule', rule } };
            key = `tool_rule ${rule}`;
        }
        else if (kind === 'capability') {
            const capabilityId = normalizeString(target.capabilityId ?? target.capability_id);
            if (!capabilityId)
                continue;
            const implementation = parseCapabilityImplementation(target.implementation);
            normalized = {
                target: {
                    kind: 'capability',
                    capabilityId,
                    ...(implementation ? { implementation } : {}),
                },
            };
            key = `capability ${capabilityId} ${implementation?.kind ?? ''} ${implementation?.name ?? ''}`;
        }
        else if (kind === 'mcp_server') {
            const server = normalizeString(target.server);
            if (!server)
                continue;
            normalized = { target: { kind: 'mcp_server', server } };
            key = `mcp_server ${server}`;
        }
        else {
            continue;
        }
        if (reason)
            normalized.reason = reason;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(normalized);
    }
    return out;
}
function parseCapabilityImplementation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }
    const record = input;
    const kind = normalizeString(record.kind);
    if (kind !== 'configured_access' &&
        kind !== 'local_cli' &&
        kind !== 'mcp_server' &&
        kind !== 'builtin_tool') {
        return undefined;
    }
    const implementation = { kind };
    const name = normalizeString(record.name);
    if (name)
        implementation.name = name;
    const executablePath = normalizeString(record.executablePath ?? record.executable_path);
    if (executablePath)
        implementation.executablePath = executablePath;
    const executableVersion = normalizeString(record.executableVersion ?? record.executable_version);
    if (executableVersion)
        implementation.executableVersion = executableVersion;
    const executableHash = normalizeString(record.executableHash ?? record.executable_hash);
    if (executableHash)
        implementation.executableHash = executableHash;
    const commandTemplate = normalizeString(record.commandTemplate ?? record.command_template);
    if (commandTemplate)
        implementation.commandTemplate = commandTemplate;
    const authPreflight = normalizeString(record.authPreflight ?? record.auth_preflight);
    if (authPreflight)
        implementation.authPreflight = authPreflight;
    const protectedPaths = parseToolAccessRequirements(record.protectedPaths ?? record.protected_paths);
    if (protectedPaths.length > 0)
        implementation.protectedPaths = protectedPaths;
    const networkHosts = parseToolAccessRequirements(record.networkHosts ?? record.network_hosts);
    if (networkHosts.length > 0)
        implementation.networkHosts = networkHosts;
    return implementation;
}
function resolveExecutionContext(job, agentId) {
    const parsed = parseExecutionContext(job.execution_context);
    if (parsed)
        return parsed;
    const firstRouteConversation = parseNotificationRoutes(job.notification_routes)[0]?.conversationJid;
    const fallbackConversation = normalizeString(firstRouteConversation);
    if (!fallbackConversation) {
        throw new Error(`Job ${'id' in job ? String(job.id) : '<unknown>'} is missing execution context conversation.`);
    }
    return {
        conversationJid: fallbackConversation,
        threadId: normalizeNullableString(job.thread_id),
        workspaceKey: normalizeString(job.workspace_key) ?? agentId.replace(/^agent:/, ''),
        sessionId: normalizeNullableString(job.session_id),
    };
}
function mergeExecutionContextSessionId(executionContext, sessionId) {
    const fallback = normalizeNullableString(sessionId);
    return executionContext.sessionId || !fallback
        ? executionContext
        : { ...executionContext, sessionId: fallback };
}
function resolveNotificationRoutes(job, executionContext) {
    const explicitRoutes = parseNotificationRoutes(job.notification_routes);
    if (explicitRoutes.length > 0)
        return explicitRoutes;
    return [
        {
            conversationJid: executionContext.conversationJid,
            threadId: executionContext.threadId,
            label: 'Primary',
        },
    ];
}
function normalizeString(input) {
    if (typeof input !== 'string')
        return undefined;
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function resolveNotificationRoutesFromTarget(input) {
    const explicitRoutes = parseNotificationRoutes(input.targetRoutes);
    if (explicitRoutes.length > 0)
        return explicitRoutes;
    if (!input.executionContext.conversationJid)
        return [];
    return [
        {
            conversationJid: input.executionContext.conversationJid,
            threadId: input.executionContext.threadId,
            label: 'Primary',
        },
    ];
}
// prettier-ignore
function normalizeNullableString(input) { return input === null || input === undefined ? null : (normalizeString(input) ?? null); }
