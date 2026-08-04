import { randomUUID } from 'node:crypto';
import { assertSafeExecutionProviderId } from '../../../../domain/sessions/execution-provider-id.js';
import { PostgresCanonicalBindingRepository } from '../repositories/canonical-binding-repository.postgres.js';
import { DEFAULT_LLM_PROFILE_ID, PostgresCanonicalGraphRepository, configVersionIdForAgent, } from '../repositories/canonical-graph-repository.postgres.js';
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
export class PostgresRuntimeRepositoryBundle {
    pool;
    db;
    options;
    graph;
    messages;
    jobs;
    sessions;
    bindings;
    routerState;
    constructor(pool, db, options) {
        this.pool = pool;
        this.db = db;
        this.options = options;
        const repositories = createPostgresDomainRepositories(this.db, this.pool, {
            maxLiveAdmissionBacklog: this.options.maxLiveAdmissionBacklog,
        });
        this.graph = new PostgresCanonicalGraphRepository(this.db);
        this.messages = new CanonicalMessageOpsService(new PostgresCanonicalMessageRepository(this.db, this.options.maxLiveAdmissionBacklog), this.options.liveAdmissionNotifier);
        this.jobs = new CanonicalJobOpsService(new PostgresCanonicalJobRepository(this.db));
        this.sessions = new CanonicalSessionOpsService(new PostgresCanonicalSessionRepository(this.db), {
            ...repositories,
            loadAppMemoryItems: this.options.sessions?.loadAppMemoryItems,
        }, this.options.sessions);
        this.bindings = new CanonicalBindingOpsService(new PostgresCanonicalBindingRepository(this.db));
        this.routerState = new PostgresCanonicalRouterStateRepository(this.db);
    }
    async close() {
        await this.pool.end();
    }
    async storeChatMetadata(chatJid, timestamp, name, channel, isGroup, options = {}) {
        await this.graph.ensureConversation(chatJid, {
            name,
            channel,
            isGroup,
            timestamp,
            providerAccountId: options.providerAccountId,
        });
    }
    async getAllChats() {
        return this.graph.listChats();
    }
    async storeMessage(msg) {
        await this.messages.storeMessage(msg);
    }
    async storeMessageWithLiveAdmission(msg, admission) {
        return this.messages.storeMessageWithLiveAdmission(msg, admission);
    }
    async notifyLiveAdmissionWorkItem(result) {
        return this.messages.notifyLiveAdmissionWorkItem(result);
    }
    async getMessagesSince(chatJid, sinceCursor, limit = 200, options = {}) {
        return this.messages.getMessagesSince(chatJid, sinceCursor, limit, options);
    }
    async getContextMessagesSince(chatJid, sinceCursor, limit = 200, options = {}) {
        return this.messages.getContextMessagesSince(chatJid, sinceCursor, limit, options);
    }
    async getRecentTopLevelMessagesBefore(chatJid, before, limit = 30, options = {}) {
        return this.messages.getRecentTopLevelMessagesBefore(chatJid, before, limit, options);
    }
    async getFirstThreadMessages(chatJid, threadId, limit = 50, options = {}) {
        return this.messages.getFirstThreadMessages(chatJid, threadId, limit, options);
    }
    async getLatestThreadMessages(chatJid, threadId, beforeOrAt, limit = 50, options = {}) {
        return this.messages.getLatestThreadMessages(chatJid, threadId, beforeOrAt, limit, options);
    }
    async getMessageThreadIds(chatJid, options = {}) {
        return this.messages.getMessageThreadIds(chatJid, options);
    }
    async getLastBotMessageCursor(chatJid, options = {}) {
        return this.messages.getLastBotMessageCursor(chatJid, options);
    }
    async getLastBotMessageTimestamp(chatJid, options = {}) {
        return this.messages.getLastBotMessageTimestamp(chatJid, options);
    }
    async upsertJob(job) {
        return this.jobs.upsertJob(job);
    }
    async getJobById(id) {
        return this.jobs.getJobById(id);
    }
    async getAllJobs() {
        return this.jobs.getAllJobs();
    }
    async listJobs(filters) {
        return this.jobs.listJobs(filters);
    }
    async getRecentJobRuns(limit = 200) {
        return this.jobs.getRecentJobRuns(limit);
    }
    async updateJob(id, updates) {
        await this.jobs.updateJob(id, updates);
    }
    async deleteJob(id) {
        await this.jobs.deleteJob(id);
    }
    async deleteExpiredCompletedOneTimeJobs(nowIso) {
        return this.jobs.deleteExpiredCompletedOneTimeJobs(nowIso);
    }
    async claimDueJobRunStart(input) {
        return this.jobs.claimDueJobRunStart(input);
    }
    async settleJobRunLease(input) {
        return this.jobs.settleJobRunLease(input);
    }
    async releaseStaleJobLeases(nowIso) {
        return this.jobs.releaseStaleJobLeases(nowIso);
    }
    async createJobRun(run) {
        return this.jobs.createJobRun(run);
    }
    async completeJobRun(runId, status, resultSummary = null, errorSummary = null) {
        await this.jobs.completeJobRun(runId, status, resultSummary, errorSummary);
    }
    async completeJobRunWithLease(input) {
        return this.jobs.completeJobRunWithLease(input);
    }
    async finalizeJobRunLease(input) {
        return this.jobs.finalizeJobRunLease(input);
    }
    async finalizeJobRunWithLease(input) {
        return this.jobs.finalizeJobRunWithLease(input);
    }
    async markJobRunNotified(runId, lease) {
        return this.jobs.markJobRunNotified(runId, lease);
    }
    async getJobRunById(runId) {
        return this.jobs.getJobRunById(runId);
    }
    async listJobRuns(jobId, limit = 50, filters) {
        return this.jobs.listJobRuns(jobId, limit, filters);
    }
    async listLatestJobRunsByJobIds(jobIds) {
        return this.jobs.listLatestJobRunsByJobIds(jobIds);
    }
    async listDeadLetterRuns(limit = 50) {
        return this.jobs.listDeadLetterRuns(limit);
    }
    async listRecentJobEvents(limit = 200, filters) {
        return this.jobs.listRecentJobEvents(limit, filters);
    }
    async getRouterState(key) {
        return this.routerState.get(key);
    }
    async setRouterState(key, value) {
        await this.routerState.set(key, value);
    }
    async setSession(agentFolder, sessionId, threadId, metadata) {
        return this.sessions.setSession(agentFolder, sessionId, threadId, {
            appId: metadata.appId,
            executionProviderId: metadata.executionProviderId,
            chatJid: metadata.conversationJid,
            providerAccountId: metadata.providerAccountId,
            conversationKind: metadata.conversationKind,
            memoryUserId: metadata.memoryUserId,
            expectedAgentSessionId: metadata.expectedAgentSessionId,
            expectedAgentSessionResetAt: metadata.expectedAgentSessionResetAt,
            accessFingerprint: metadata.accessFingerprint,
        });
    }
    async getAgentTurnContext(input) {
        return this.sessions.getAgentTurnContext({
            appId: input.appId,
            workspaceFolder: input.agentFolder,
            executionProviderId: input.executionProviderId,
            chatJid: input.conversationJid,
            providerAccountId: input.providerAccountId,
            threadId: input.threadId,
            conversationKind: input.conversationKind,
            memoryUserId: input.memoryUserId,
            jobId: input.jobId,
            query: input.query,
            hydrateMemory: input.hydrateMemory,
            hydrationMode: input.hydrationMode,
            promoteReadyProviderSession: input.promoteReadyProviderSession,
        });
    }
    async expireProviderSession(input) {
        await this.sessions.expireProviderSession(input);
    }
    async markProviderSessionMaintenance(input) {
        return this.sessions.markProviderSessionMaintenance(input);
    }
    async markProviderSessionDeltaReplay(input) {
        await this.sessions.markProviderSessionDeltaReplay(input);
    }
    async finishProviderSessionMaintenance(input) {
        await this.sessions.finishProviderSessionMaintenance(input);
    }
    async createSessionAgentRun(input) {
        assertSafeExecutionProviderId(input.executionProviderId);
        const repositories = createPostgresDomainRepositories(this.db, this.pool);
        const session = await repositories.agentSessions.getAgentSession(input.agentSessionId);
        if (!session)
            return undefined;
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
        });
        await this.options.runtimeEvents.publish({
            appId: session.appId,
            runId: runId,
            sessionId: session.id,
            eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
            actor: 'runtime',
            // Resolved-run diagnostics for the live lane: the inherited agent engine
            // (derived from the diagnostic executionProviderId) and the diagnostic id
            // itself. No secrets. The DB-layer emit does not have the modelAlias /
            // sandbox provider at this point; those live on the scheduled-lane payload.
            payload: {
                cause: input.cause,
                agent_engine: engineForExecutionProviderId(input.executionProviderId) ?? null,
                execution_provider_id: input.executionProviderId,
            },
            createdAt: now,
        });
        return runId;
    }
    async updateAgentRunProviderMetadata(input) {
        return this.jobs.updateAgentRunProviderMetadata(input);
    }
    async completeSessionAgentRun(input) {
        const repositories = createPostgresDomainRepositories(this.db, this.pool);
        const run = await repositories.agentRuns.getAgentRun(input.runId);
        if (!run)
            return;
        const resultSummary = input.resultSummary == null
            ? input.resultSummary
            : redactProviderSessionHandlesInText(input.resultSummary);
        const errorSummary = input.errorSummary == null
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
            eventType: input.status === 'completed'
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
    async deleteSession(agentFolder, threadId, metadata = {}) {
        await this.sessions.deleteSession(agentFolder, threadId, {
            appId: metadata.appId,
            chatJid: metadata.conversationJid,
            providerAccountId: metadata.providerAccountId,
            conversationKind: metadata.conversationKind,
            memoryUserId: metadata.memoryUserId,
            agentId: metadata.agentId,
        });
    }
    async deleteSessionsByAgentFolder(agentFolder) {
        await this.sessions.deleteSessionsByWorkspaceFolder(agentFolder);
    }
    async getConversationRoute(jid) {
        return this.bindings.getConversationRoute(jid);
    }
    async setConversationRoute(jid, group) {
        await this.bindings.setConversationRoute(jid, group);
    }
    async deleteConversationRoute(jid) {
        await this.bindings.deleteConversationRoute(jid);
    }
    async getAllConversationRoutes() {
        return this.bindings.getAllConversationRoutes();
    }
}
