import { and, asc, desc, eq, gt, inArray, isNull, or, sql, } from 'drizzle-orm';
import { assertSafeExecutionProviderId } from '../../../../domain/sessions/execution-provider-id.js';
import * as pgSchema from '../schema/schema.js';
import { CANONICAL_APP_ID, jsonb, } from './canonical-graph-repository.postgres.js';
import { PostgresAgentSessionRepository, PostgresAgentSessionDigestRepository, PostgresAgentSessionSummaryRepository, PostgresProviderSessionRepository, } from './session-repositories.postgres.js';
import { PostgresMcpServerRepository } from './mcp-server-repository.postgres.js';
import { PostgresSkillCatalogRepository } from './skill-repository.postgres.js';
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';
import { PostgresToolCatalogRepository } from './tool-repository.postgres.js';
import { PostgresAgentRepository } from './agent-repository.postgres.js';
import { PostgresOutboundDeliveryRepository } from './outbound-delivery-repository.postgres.js';
import { PostgresCapabilitySecretRepository } from './capability-secret-repository.postgres.js';
import { PostgresModelCredentialRepository } from './model-credential-repository.postgres.js';
import { PostgresPendingAccessRequestsRepository } from './pending-access-request-repository.postgres.js';
import { PostgresWorkerCoordinationRepository } from './worker-coordination-repository.postgres.js';
import { PostgresLiveTurnRepository } from './live-turn-repository.postgres.js';
import { PostgresRuntimeDependencyRepository } from './runtime-dependency-repository.postgres.js';
import { PostgresSettingsRevisionRepository } from './settings-revision-repository.postgres.js';
import { PostgresAsyncTaskRepository } from './async-task-repository.postgres.js';
import { PostgresPatternCandidateRepository } from './pattern-candidate-repository.postgres.js';
import { PostgresProactiveSurfacingRepository } from './proactive-surfacing-repository.postgres.js';
import { PostgresObserverInsightRepository } from './observer-insight-repository.postgres.js';
import { PostgresChatBatchRepository } from './chat-batch-repository.postgres.js';
import { PostgresPermissionPromotionRepository } from './permission-promotion-repository.postgres.js';
import { PostgresPermissionDecisionMemoryRepository } from './permission-decision-memory-repository.postgres.js';
import { PostgresGroupJoinOnboardingRepository } from './group-join-onboarding-repository.postgres.js';
function encodeJson(value) {
    return JSON.stringify(value ?? null);
}
function encodeJsonOrNull(value) {
    return value === undefined ? null : encodeJson(value);
}
function jsonbOrNull(value) {
    return value === undefined ? null : value;
}
function parseJson(value, fallback) {
    if (value === null || value === undefined)
        return fallback;
    if (typeof value !== 'string')
        return value;
    if (value.length === 0)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch (err) {
        if (!(err instanceof SyntaxError)) {
            throw err;
        }
        return fallback;
    }
}
function toIsoTimestamp(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
function isUniqueViolation(err) {
    // Drizzle wraps the pg error (the SQLSTATE lives on the cause chain), so
    // walk causes like file-artifact-repository's sqlStateCode does.
    let current = err;
    for (let depth = 0; depth < 5; depth += 1) {
        if (!current || typeof current !== 'object')
            return false;
        const code = current.code;
        if (code === '23505')
            return true;
        current = current.cause;
    }
    return false;
}
function parseJsonArray(value) {
    const parsed = parseJson(value, []);
    return Array.isArray(parsed)
        ? parsed.filter((v) => typeof v === 'string')
        : [];
}
export function parseRuntimeSecretRefsJson(value, providerId) {
    const parsed = typeof value === 'string'
        ? value.length > 0
            ? JSON.parse(value)
            : {}
        : (value ?? {});
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`provider account ${providerId} runtimeSecretRefs must be a JSON object keyed by credential name`);
    }
    const refs = {};
    for (const [key, ref] of Object.entries(parsed)) {
        if (typeof ref !== 'string') {
            throw new Error(`provider account ${providerId} runtimeSecretRefs.${key} must be a string ref`);
        }
        refs[key] = ref;
    }
    return refs;
}
function safeIdPart(value) {
    return value.trim().replace(/[^a-zA-Z0-9._:@-]/g, '_');
}
function channelControlApproverId(conversationId, externalUserId) {
    return `channel-control:${safeIdPart(conversationId)}:${safeIdPart(externalUserId)}`;
}
// Real approver IDs cannot be empty, so this row durably records a clear.
const AUTHORITATIVE_EMPTY_APPROVER = '';
function externalRef(value, fallbackKind, fallbackValue) {
    const parsed = parseJson(value, {});
    if (typeof parsed.kind === 'string' && typeof parsed.value === 'string') {
        return { kind: parsed.kind, value: parsed.value };
    }
    const fallbackRefValue = typeof parsed.jid === 'string'
        ? parsed.jid
        : typeof parsed.threadId === 'string'
            ? parsed.threadId
            : typeof parsed.externalId === 'string'
                ? parsed.externalId
                : fallbackValue;
    return fallbackRefValue
        ? { kind: fallbackKind, value: fallbackRefValue }
        : undefined;
}
function jsonTextEquals(column, keys, value) {
    return sql `(${column} IS NOT NULL AND (${sql.join(keys.map((key) => sql `${column}::jsonb->>${key} = ${value}`), sql ` OR `)}))`;
}
function _memorySubjectFromRow(row) {
    if (row.subjectType === 'agent') {
        return {
            kind: 'agent',
            appId: row.appId,
            agentId: row.subjectId,
        };
    }
    if (row.subjectType === 'user') {
        return {
            kind: 'user',
            appId: row.appId,
            userId: row.userId ?? row.subjectId,
        };
    }
    if (row.subjectType === 'conversation') {
        return {
            kind: 'conversation',
            appId: row.appId,
            conversationId: row.conversationId ?? row.subjectId,
        };
    }
    return { kind: 'app', appId: row.appId };
}
function messagePartToPayload(part) {
    switch (part.kind) {
        case 'text':
            return { text: part.text };
        case 'markdown':
            return { markdown: part.markdown };
        case 'code':
            return { language: part.language, code: part.code };
        case 'structured':
            return { value: part.value };
        case 'tool_result':
            return { toolId: part.toolId, value: part.value };
        case 'redacted':
            return { reason: part.reason };
    }
}
function payloadToMessagePart(kind, payloadJson) {
    const payload = parseJson(payloadJson, {});
    switch (kind) {
        case 'markdown':
            return { kind: 'markdown', markdown: String(payload.markdown ?? '') };
        case 'code':
            return {
                kind: 'code',
                language: typeof payload.language === 'string' ? payload.language : undefined,
                code: String(payload.code ?? ''),
            };
        case 'structured':
            return { kind: 'structured', value: payload.value };
        case 'tool_result':
            return {
                kind: 'tool_result',
                toolId: String(payload.toolId ?? ''),
                value: payload.value,
            };
        case 'redacted':
            return { kind: 'redacted', reason: String(payload.reason ?? '') };
        default:
            return { kind: 'text', text: String(payload.text ?? '') };
    }
}
export class PostgresAppRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getApp(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.appsPostgres)
            .where(eq(pgSchema.appsPostgres.id, id))
            .limit(1);
        return rows[0] ?? null;
    }
    async saveApp(app) {
        await this.db
            .insert(pgSchema.appsPostgres)
            .values(app)
            .onConflictDoUpdate({
            target: pgSchema.appsPostgres.id,
            set: {
                slug: app.slug,
                name: app.name,
                status: app.status,
                updatedAt: app.updatedAt,
            },
        });
    }
}
export class PostgresAgentConfigRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getConfigVersion(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentConfigVersionsPostgres)
            .where(eq(pgSchema.agentConfigVersionsPostgres.id, id))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return {
            id: row.id,
            appId: row.appId,
            agentId: row.agentId,
            version: row.version,
            promptProfileRef: row.promptProfileRef,
            llmProfileId: row.llmProfileId,
            toolIds: parseJsonArray(row.toolIdsJson),
            skillIds: parseJsonArray(row.skillIdsJson),
            permissionPolicyIds: parseJsonArray(row.permissionPolicyIdsJson),
            sandboxProfileId: row.sandboxProfileId ?? undefined,
            workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
            runtimeLimits: parseJson(row.runtimeLimitsJson, undefined),
            createdAt: row.createdAt,
        };
    }
    async saveConfigVersion(version) {
        await this.db
            .insert(pgSchema.agentConfigVersionsPostgres)
            .values({
            id: version.id,
            appId: version.appId,
            agentId: version.agentId,
            version: version.version,
            promptProfileRef: version.promptProfileRef,
            llmProfileId: version.llmProfileId,
            toolIdsJson: encodeJson(version.toolIds),
            skillIdsJson: encodeJson(version.skillIds),
            permissionPolicyIdsJson: encodeJson(version.permissionPolicyIds),
            sandboxProfileId: version.sandboxProfileId ?? null,
            workspaceSnapshotId: version.workspaceSnapshotId ?? null,
            runtimeLimitsJson: encodeJson(version.runtimeLimits ?? {}),
            createdAt: version.createdAt,
        })
            .onConflictDoNothing();
    }
}
export class PostgresProviderAccountRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async listProviderAccounts(appId) {
        const rows = await this.db
            .select()
            .from(pgSchema.providerAccountsPostgres)
            .where(eq(pgSchema.providerAccountsPostgres.appId, appId))
            .orderBy(asc(pgSchema.providerAccountsPostgres.createdAt));
        return rows.map((row) => this.providerAccountFromRow(row));
    }
    async getProviderAccount(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.providerAccountsPostgres)
            .where(eq(pgSchema.providerAccountsPostgres.id, id))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return this.providerAccountFromRow(row);
    }
    providerAccountFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentId: row.agentId,
            providerId: row.providerId,
            externalIdentityRef: externalRef(row.externalIdentityRefJson, 'provider_account'),
            label: row.label,
            status: row.status,
            config: parseJson(row.configJson, {}),
            runtimeSecretRefs: parseRuntimeSecretRefsJson(row.runtimeSecretRefsJson, row.providerId),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    async saveProviderAccount(providerAccount) {
        await this.db.transaction(async (tx) => {
            await tx
                .insert(pgSchema.providersPostgres)
                .values({
                id: providerAccount.providerId,
                displayName: providerAccount.providerId,
            })
                .onConflictDoNothing();
            await tx
                .insert(pgSchema.providerAccountsPostgres)
                .values({
                id: providerAccount.id,
                appId: providerAccount.appId,
                agentId: providerAccount.agentId,
                providerId: providerAccount.providerId,
                externalIdentityRefJson: encodeJsonOrNull(providerAccount.externalIdentityRef),
                label: providerAccount.label,
                status: providerAccount.status,
                configJson: encodeJson(providerAccount.config ?? {}),
                runtimeSecretRefsJson: encodeJson(providerAccount.runtimeSecretRefs),
                createdAt: providerAccount.createdAt,
                updatedAt: providerAccount.updatedAt,
            })
                .onConflictDoUpdate({
                target: pgSchema.providerAccountsPostgres.id,
                set: {
                    agentId: providerAccount.agentId,
                    externalIdentityRefJson: encodeJsonOrNull(providerAccount.externalIdentityRef),
                    label: providerAccount.label,
                    status: providerAccount.status,
                    configJson: encodeJson(providerAccount.config ?? {}),
                    runtimeSecretRefsJson: encodeJson(providerAccount.runtimeSecretRefs),
                    updatedAt: providerAccount.updatedAt,
                },
            });
        });
    }
    async updateProviderAccount(input) {
        const set = {
            updatedAt: input.updatedAt,
        };
        if (input.patch.label !== undefined)
            set.label = input.patch.label;
        if (input.patch.status !== undefined)
            set.status = input.patch.status;
        if (input.patch.config !== undefined) {
            set.configJson = encodeJson(input.patch.config ?? {});
        }
        if (input.patch.runtimeSecretRefs !== undefined) {
            set.runtimeSecretRefsJson = encodeJson(input.patch.runtimeSecretRefs);
        }
        if (input.patch.externalIdentityRef !== undefined) {
            set.externalIdentityRefJson = encodeJsonOrNull(input.patch.externalIdentityRef ?? undefined);
        }
        const rows = await this.db
            .update(pgSchema.providerAccountsPostgres)
            .set(set)
            .where(and(eq(pgSchema.providerAccountsPostgres.appId, input.appId), eq(pgSchema.providerAccountsPostgres.id, input.id)))
            .returning();
        return rows[0] ? this.providerAccountFromRow(rows[0]) : null;
    }
    async disableProviderAccount(input) {
        await this.db
            .update(pgSchema.providerAccountsPostgres)
            .set({ status: 'disabled', updatedAt: input.updatedAt })
            .where(and(eq(pgSchema.providerAccountsPostgres.appId, input.appId), eq(pgSchema.providerAccountsPostgres.id, input.id)));
        return await this.getProviderAccount(input.id);
    }
    async saveConversationInstall(binding) {
        await this.db
            .insert(pgSchema.conversationInstallsPostgres)
            .values({
            id: binding.id,
            appId: binding.appId,
            agentId: binding.agentId,
            providerAccountId: binding.providerAccountId,
            conversationId: binding.conversationId,
            threadId: binding.threadId ?? null,
            displayName: binding.displayName,
            status: binding.status,
            senderPolicy: binding.senderPolicy,
            controlPolicy: binding.controlPolicy,
            memoryScope: binding.memoryScope,
            memorySubjectJson: encodeJson(binding.memorySubject),
            workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
            permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
            createdAt: binding.createdAt,
            updatedAt: binding.updatedAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.conversationInstallsPostgres.id,
            set: {
                agentId: binding.agentId,
                providerAccountId: binding.providerAccountId,
                conversationId: binding.conversationId,
                threadId: binding.threadId ?? null,
                displayName: binding.displayName,
                status: binding.status,
                senderPolicy: binding.senderPolicy,
                controlPolicy: binding.controlPolicy,
                memoryScope: binding.memoryScope,
                memorySubjectJson: encodeJson(binding.memorySubject),
                workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
                permissionPolicyIdsJson: encodeJson(binding.permissionPolicyIds),
                updatedAt: binding.updatedAt,
            },
        });
    }
    async disableConversationInstall(input) {
        const b = pgSchema.conversationInstallsPostgres;
        const rows = await this.db
            .update(b)
            .set({ status: 'disabled', updatedAt: input.updatedAt })
            .where(and(eq(b.appId, input.appId), eq(b.agentId, input.agentId), eq(b.conversationId, input.conversationId), sql `${b.id} not like 'conversation-route:%'`, input.threadId ? eq(b.threadId, input.threadId) : isNull(b.threadId)))
            .returning();
        return rows[0] ? this.bindingFromRow(rows[0]) : null;
    }
    async getConversationInstall(input) {
        const b = pgSchema.conversationInstallsPostgres;
        const controlBindingPredicate = sql `${b.id} not like 'conversation-route:%'`;
        const threadPredicate = input.threadId
            ? input.exactThreadId
                ? eq(b.threadId, input.threadId)
                : or(eq(b.threadId, input.threadId), isNull(b.threadId))
            : isNull(b.threadId);
        const rows = await this.db
            .select()
            .from(b)
            .where(and(eq(b.appId, input.appId), eq(b.agentId, input.agentId), eq(b.conversationId, input.conversationId), controlBindingPredicate, threadPredicate))
            .orderBy(sql `CASE WHEN ${b.threadId} IS NULL THEN 1 ELSE 0 END`, asc(b.id))
            .limit(1);
        return rows[0] ? this.bindingFromRow(rows[0]) : null;
    }
    async isAgentEnabledInConversation(input) {
        const b = await this.getConversationInstall(input);
        if (!b)
            return false;
        if (b.status !== 'active')
            return false;
        const rows = await this.db
            .select({ id: pgSchema.agentsPostgres.id })
            .from(pgSchema.agentsPostgres)
            .innerJoin(pgSchema.providerAccountsPostgres, eq(pgSchema.providerAccountsPostgres.id, b.providerAccountId))
            .innerJoin(pgSchema.conversationsPostgres, eq(pgSchema.conversationsPostgres.id, b.conversationId))
            .where(and(eq(pgSchema.agentsPostgres.id, b.agentId), eq(pgSchema.agentsPostgres.status, 'active'), eq(pgSchema.providerAccountsPostgres.status, 'active'), eq(pgSchema.conversationsPostgres.status, 'active')))
            .limit(1);
        return rows.length > 0;
    }
    async listConversationInstalls(appId, agentId) {
        const b = pgSchema.conversationInstallsPostgres;
        const rows = await this.db
            .select()
            .from(b)
            .where(and(eq(b.appId, appId), agentId ? eq(b.agentId, agentId) : undefined, sql `${b.id} not like 'conversation-route:%'`))
            .orderBy(asc(b.createdAt));
        return rows.map((row) => this.bindingFromRow(row));
    }
    async listConversationInstallsByConversation(input) {
        const b = pgSchema.conversationInstallsPostgres;
        const rows = await this.db
            .select()
            .from(b)
            .where(and(eq(b.appId, input.appId), eq(b.conversationId, input.conversationId), sql `${b.id} not like 'conversation-route:%'`))
            .orderBy(asc(b.createdAt));
        return rows.map((row) => this.bindingFromRow(row));
    }
    bindingFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentId: row.agentId,
            providerAccountId: row.providerAccountId,
            conversationId: row.conversationId,
            threadId: row.threadId ?? undefined,
            displayName: row.displayName,
            status: (row.status ?? 'active'),
            senderPolicy: (row.senderPolicy ??
                'provider_native'),
            controlPolicy: (row.controlPolicy ??
                'conversation_approvers'),
            memoryScope: (row.memoryScope ??
                'conversation'),
            memorySubject: parseJson(row.memorySubjectJson, {
                kind: 'conversation',
                appId: row.appId,
                conversationId: row.conversationId,
            }),
            workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
            permissionPolicyIds: parseJsonArray(row.permissionPolicyIdsJson),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}
export class PostgresConversationRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async listConversations(input) {
        const rows = await this.db
            .select()
            .from(pgSchema.conversationsPostgres)
            .where(and(eq(pgSchema.conversationsPostgres.appId, input.appId), eq(pgSchema.conversationsPostgres.status, 'active'), input.providerAccountId
            ? eq(pgSchema.conversationsPostgres.providerAccountId, input.providerAccountId)
            : undefined))
            .orderBy(asc(pgSchema.conversationsPostgres.createdAt));
        return rows.map((row) => this.conversationFromRow(row));
    }
    async getConversation(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.conversationsPostgres)
            .where(eq(pgSchema.conversationsPostgres.id, id))
            .limit(1);
        return rows[0] ? this.conversationFromRow(rows[0]) : null;
    }
    async getConversationByExternalRef(input) {
        const c = pgSchema.conversationsPostgres;
        const ci = pgSchema.providerAccountsPostgres;
        const rows = await this.db
            .select({ conversation: c })
            .from(c)
            .innerJoin(ci, eq(ci.id, c.providerAccountId))
            .where(and(eq(c.appId, input.appId), eq(c.status, 'active'), eq(ci.providerId, input.providerId), eq(c.providerAccountId, input.providerAccountId), jsonTextEquals(c.externalRefJson, ['value', 'jid', 'externalConversationId'], input.externalConversationId)))
            .limit(1);
        return rows[0] ? this.conversationFromRow(rows[0].conversation) : null;
    }
    async findConversationByExternalValue(input) {
        const c = pgSchema.conversationsPostgres;
        const rows = await this.db
            .select()
            .from(c)
            .where(and(eq(c.appId, input.appId), jsonTextEquals(c.externalRefJson, ['value', 'jid', 'externalConversationId'], input.externalConversationId)))
            .limit(1);
        return rows[0] ? this.conversationFromRow(rows[0]) : null;
    }
    async getThread(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.conversationThreadsPostgres)
            .where(eq(pgSchema.conversationThreadsPostgres.id, id))
            .limit(1);
        return rows[0] ? this.threadFromRow(rows[0]) : null;
    }
    async getThreadByExternalRef(input) {
        const t = pgSchema.conversationThreadsPostgres;
        const c = pgSchema.conversationsPostgres;
        const ci = pgSchema.providerAccountsPostgres;
        const rows = await this.db
            .select({ thread: t })
            .from(t)
            .innerJoin(c, eq(c.id, t.conversationId))
            .innerJoin(ci, eq(ci.id, c.providerAccountId))
            .where(and(eq(t.appId, input.appId), eq(t.conversationId, input.conversationId), eq(ci.providerId, input.providerId), jsonTextEquals(t.externalRefJson, ['value', 'threadId', 'externalThreadId'], input.externalThreadId)))
            .limit(1);
        return rows[0] ? this.threadFromRow(rows[0].thread) : null;
    }
    async saveConversation(conversation) {
        await this.db
            .insert(pgSchema.conversationsPostgres)
            .values({
            id: conversation.id,
            appId: conversation.appId,
            providerAccountId: conversation.providerAccountId,
            externalRefJson: encodeJsonOrNull(conversation.externalRef),
            kind: conversation.kind,
            title: conversation.title ?? null,
            status: conversation.status,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.conversationsPostgres.id,
            set: {
                providerAccountId: conversation.providerAccountId,
                externalRefJson: encodeJsonOrNull(conversation.externalRef),
                kind: conversation.kind,
                title: conversation.title ?? null,
                status: conversation.status,
                updatedAt: conversation.updatedAt,
            },
        });
    }
    async saveThread(thread) {
        await this.db
            .insert(pgSchema.conversationThreadsPostgres)
            .values({
            id: thread.id,
            appId: thread.appId,
            conversationId: thread.conversationId,
            externalRefJson: encodeJsonOrNull(thread.externalRef),
            title: thread.title ?? null,
            status: thread.status,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.conversationThreadsPostgres.id,
            set: {
                externalRefJson: encodeJsonOrNull(thread.externalRef),
                title: thread.title ?? null,
                status: thread.status,
                updatedAt: thread.updatedAt,
            },
        });
    }
    async listThreads(conversationId) {
        const rows = await this.db
            .select()
            .from(pgSchema.conversationThreadsPostgres)
            .where(eq(pgSchema.conversationThreadsPostgres.conversationId, conversationId))
            .orderBy(asc(pgSchema.conversationThreadsPostgres.createdAt));
        return rows.map((row) => this.threadFromRow(row));
    }
    async listParticipantExternalUserIds(conversationId) {
        const rows = await this.db
            .select({
            externalUserId: pgSchema.conversationParticipantsPostgres.externalUserId,
        })
            .from(pgSchema.conversationParticipantsPostgres)
            .where(and(eq(pgSchema.conversationParticipantsPostgres.conversationId, conversationId), eq(pgSchema.conversationParticipantsPostgres.status, 'active')))
            .orderBy(asc(pgSchema.conversationParticipantsPostgres.externalUserId));
        return rows
            .map((row) => row.externalUserId?.trim() || '')
            .filter((id) => id.length > 0);
    }
    async listConversationApprovers(conversationId) {
        return (await this.listConversationApproverRows([conversationId])).filter((approver) => approver.externalUserId !== AUTHORITATIVE_EMPTY_APPROVER);
    }
    async listConversationApproversForConversations(conversationIds) {
        return this.listConversationApproverRows(conversationIds);
    }
    async listConversationApproverRows(conversationIds) {
        if (conversationIds.length === 0)
            return [];
        const rows = await this.db
            .select()
            .from(pgSchema.conversationApproversPostgres)
            .where(inArray(pgSchema.conversationApproversPostgres.conversationId, [
            ...conversationIds,
        ]))
            .orderBy(asc(pgSchema.conversationApproversPostgres.conversationId), asc(pgSchema.conversationApproversPostgres.externalUserId));
        return rows.map((row) => ({
            id: row.id,
            appId: row.appId,
            conversationId: row.conversationId,
            externalUserId: row.externalUserId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        }));
    }
    async replaceConversationApprovers(input) {
        await this.db.transaction(async (tx) => {
            await tx
                .delete(pgSchema.conversationApproversPostgres)
                .where(and(eq(pgSchema.conversationApproversPostgres.appId, input.appId), eq(pgSchema.conversationApproversPostgres.conversationId, input.conversationId)));
            await tx.insert(pgSchema.conversationApproversPostgres).values((input.externalUserIds.length
                ? input.externalUserIds
                : [AUTHORITATIVE_EMPTY_APPROVER]).map((externalUserId) => ({
                id: channelControlApproverId(input.conversationId, externalUserId),
                appId: input.appId,
                conversationId: input.conversationId,
                externalUserId,
                createdAt: input.updatedAt,
                updatedAt: input.updatedAt,
            })));
        });
        return this.listConversationApprovers(input.conversationId);
    }
    conversationFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            providerAccountId: row.providerAccountId,
            externalRef: externalRef(row.externalRefJson, 'conversation'),
            kind: row.kind,
            title: row.title ?? undefined,
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    threadFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            conversationId: row.conversationId,
            externalRef: externalRef(row.externalRefJson, 'conversation_thread'),
            title: row.title ?? undefined,
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}
export class PostgresMessageRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async listConversationIdsForJid(jid) {
        const c = pgSchema.conversationsPostgres;
        const rows = await this.db
            .select({ id: c.id })
            .from(c)
            .where(and(eq(c.appId, CANONICAL_APP_ID), eq(sql `${c.externalRefJson}::jsonb->>'jid'`, jid)))
            .orderBy(asc(c.id));
        return rows.map((row) => row.id);
    }
    async getMessage(id) {
        const m = pgSchema.messagesPostgres;
        const rows = await this.db.select().from(m).where(eq(m.id, id)).limit(1);
        const row = rows[0];
        if (!row)
            return null;
        const parts = await this.db
            .select()
            .from(pgSchema.messagePartsPostgres)
            .where(eq(pgSchema.messagePartsPostgres.messageId, row.id))
            .orderBy(asc(pgSchema.messagePartsPostgres.ordinal));
        const attachments = await this.db
            .select()
            .from(pgSchema.messageAttachmentsPostgres)
            .where(eq(pgSchema.messageAttachmentsPostgres.messageId, row.id))
            .orderBy(asc(pgSchema.messageAttachmentsPostgres.id));
        return this.messageFromRows(row, parts, attachments);
    }
    async saveMessage(message) {
        try {
            await this.writeMessage(message);
        }
        catch (err) {
            if (!message.externalRef?.value || !isUniqueViolation(err)) {
                throw err;
            }
            await this.writeMessage(message);
        }
    }
    async writeMessage(message) {
        await this.db.transaction(async (tx) => {
            const c = pgSchema.conversationsPostgres;
            const ci = pgSchema.providerAccountsPostgres;
            const channelRows = await tx
                .select({
                providerAccountId: c.providerAccountId,
                providerId: ci.providerId,
            })
                .from(c)
                .innerJoin(ci, eq(ci.id, c.providerAccountId))
                .where(eq(c.id, message.conversationId))
                .limit(1);
            const channel = channelRows[0];
            if (!channel) {
                throw new Error(`Cannot save message ${message.id}: conversation ${message.conversationId} was not found`);
            }
            const externalMessageId = message.externalRef?.value ?? null;
            let targetMessageId = message.id;
            if (externalMessageId) {
                const duplicateRows = await tx
                    .select({ id: pgSchema.messagesPostgres.id })
                    .from(pgSchema.messagesPostgres)
                    .where(and(eq(pgSchema.messagesPostgres.providerId, channel.providerId), eq(pgSchema.messagesPostgres.providerAccountId, channel.providerAccountId), eq(pgSchema.messagesPostgres.conversationId, message.conversationId), message.threadId
                    ? eq(pgSchema.messagesPostgres.threadId, message.threadId)
                    : isNull(pgSchema.messagesPostgres.threadId), eq(pgSchema.messagesPostgres.externalMessageId, externalMessageId)))
                    .limit(1);
                targetMessageId = (duplicateRows[0]?.id ?? message.id);
            }
            await tx
                .insert(pgSchema.messagesPostgres)
                .values({
                id: targetMessageId,
                appId: message.appId,
                providerId: channel.providerId,
                providerAccountId: channel.providerAccountId,
                conversationId: message.conversationId,
                threadId: message.threadId ?? null,
                externalMessageId,
                externalRefJson: jsonbOrNull(message.externalRef),
                direction: message.direction,
                senderUserId: message.senderUserId ?? null,
                senderDisplayName: message.senderDisplayName ?? null,
                trust: message.trust,
                createdAt: message.createdAt,
                receivedAt: message.receivedAt ?? null,
                deliveryStatus: message.deliveryStatus ?? null,
                deliveredAt: message.deliveredAt ?? null,
                deliveryError: message.deliveryError ?? null,
            })
                .onConflictDoUpdate({
                target: pgSchema.messagesPostgres.id,
                set: {
                    externalMessageId,
                    externalRefJson: jsonbOrNull(message.externalRef),
                    direction: message.direction,
                    senderUserId: message.senderUserId ?? null,
                    senderDisplayName: message.senderDisplayName ?? null,
                    trust: message.trust,
                    receivedAt: message.receivedAt ?? null,
                    deliveryStatus: message.deliveryStatus ?? null,
                    deliveredAt: message.deliveredAt ?? null,
                    deliveryError: message.deliveryError ?? null,
                },
            });
            await tx
                .delete(pgSchema.messagePartsPostgres)
                .where(eq(pgSchema.messagePartsPostgres.messageId, targetMessageId));
            await tx
                .delete(pgSchema.messageAttachmentsPostgres)
                .where(eq(pgSchema.messageAttachmentsPostgres.messageId, targetMessageId));
            if (message.parts.length > 0) {
                await tx.insert(pgSchema.messagePartsPostgres).values(message.parts.map((part, ordinal) => ({
                    messageId: targetMessageId,
                    ordinal,
                    kind: part.kind,
                    payloadJson: jsonb(messagePartToPayload(part)),
                })));
            }
            if (message.attachments.length > 0) {
                await tx.insert(pgSchema.messageAttachmentsPostgres).values(message.attachments.map((attachment) => ({
                    id: attachment.id,
                    messageId: targetMessageId,
                    kind: attachment.kind,
                    contentType: attachment.contentType ?? null,
                    sizeBytes: attachment.sizeBytes ?? null,
                    externalRefJson: jsonbOrNull(attachment.externalRef),
                    storageRef: attachment.storageRef ?? null,
                    trust: attachment.trust,
                })));
            }
        });
    }
    async listMessages(input) {
        const m = pgSchema.messagesPostgres;
        let afterFilter;
        if (input.after) {
            const afterRows = await this.db
                .select({ createdAt: m.createdAt, id: m.id })
                .from(m)
                .where(eq(m.id, input.after))
                .limit(1);
            const after = afterRows[0];
            if (after) {
                afterFilter = or(gt(m.createdAt, after.createdAt), and(eq(m.createdAt, after.createdAt), gt(m.id, after.id)));
            }
        }
        const rows = await this.db
            .select()
            .from(m)
            .where(and(eq(m.conversationId, input.conversationId), input.threadId ? eq(m.threadId, input.threadId) : undefined, afterFilter))
            .orderBy(asc(m.createdAt), asc(m.id))
            .limit(input.limit ?? 100);
        if (rows.length === 0)
            return [];
        const ids = rows.map((row) => row.id);
        const parts = await this.db
            .select()
            .from(pgSchema.messagePartsPostgres)
            .where(inArray(pgSchema.messagePartsPostgres.messageId, ids))
            .orderBy(asc(pgSchema.messagePartsPostgres.messageId), asc(pgSchema.messagePartsPostgres.ordinal));
        const attachments = await this.db
            .select()
            .from(pgSchema.messageAttachmentsPostgres)
            .where(inArray(pgSchema.messageAttachmentsPostgres.messageId, ids))
            .orderBy(asc(pgSchema.messageAttachmentsPostgres.messageId), asc(pgSchema.messageAttachmentsPostgres.id));
        const partsByMessageId = new Map();
        for (const part of parts) {
            const existing = partsByMessageId.get(part.messageId) ?? [];
            existing.push(part);
            partsByMessageId.set(part.messageId, existing);
        }
        const attachmentsByMessageId = new Map();
        for (const attachment of attachments) {
            const existing = attachmentsByMessageId.get(attachment.messageId) ?? [];
            existing.push(attachment);
            attachmentsByMessageId.set(attachment.messageId, existing);
        }
        return rows.map((row) => this.messageFromRows(row, partsByMessageId.get(row.id) ?? [], attachmentsByMessageId.get(row.id) ?? []));
    }
    async listRecentMessages(input) {
        const m = pgSchema.messagesPostgres;
        let afterFilter;
        if (input.after) {
            const afterRows = await this.db
                .select({ createdAt: m.createdAt, id: m.id })
                .from(m)
                .where(eq(m.id, input.after))
                .limit(1);
            const after = afterRows[0];
            if (after) {
                afterFilter = or(gt(m.createdAt, after.createdAt), and(eq(m.createdAt, after.createdAt), gt(m.id, after.id)));
            }
        }
        const rows = await this.db
            .select()
            .from(m)
            .where(and(eq(m.conversationId, input.conversationId), input.threadId ? eq(m.threadId, input.threadId) : undefined, afterFilter))
            .orderBy(desc(m.createdAt), desc(m.id))
            .limit(input.limit ?? 100);
        const orderedRows = [...rows].reverse();
        if (orderedRows.length === 0)
            return [];
        const ids = orderedRows.map((row) => row.id);
        const parts = await this.db
            .select()
            .from(pgSchema.messagePartsPostgres)
            .where(inArray(pgSchema.messagePartsPostgres.messageId, ids))
            .orderBy(asc(pgSchema.messagePartsPostgres.messageId), asc(pgSchema.messagePartsPostgres.ordinal));
        const attachments = await this.db
            .select()
            .from(pgSchema.messageAttachmentsPostgres)
            .where(inArray(pgSchema.messageAttachmentsPostgres.messageId, ids))
            .orderBy(asc(pgSchema.messageAttachmentsPostgres.messageId), asc(pgSchema.messageAttachmentsPostgres.id));
        const partsByMessageId = new Map();
        for (const part of parts) {
            const existing = partsByMessageId.get(part.messageId) ?? [];
            existing.push(part);
            partsByMessageId.set(part.messageId, existing);
        }
        const attachmentsByMessageId = new Map();
        for (const attachment of attachments) {
            const existing = attachmentsByMessageId.get(attachment.messageId) ?? [];
            existing.push(attachment);
            attachmentsByMessageId.set(attachment.messageId, existing);
        }
        return orderedRows.map((row) => this.messageFromRows(row, partsByMessageId.get(row.id) ?? [], attachmentsByMessageId.get(row.id) ?? []));
    }
    messageFromRows(row, parts, attachments) {
        return {
            id: row.id,
            appId: row.appId,
            conversationId: row.conversationId,
            threadId: row.threadId ?? undefined,
            externalRef: externalRef(row.externalRefJson, 'message', row.externalMessageId),
            direction: row.direction,
            senderUserId: row.senderUserId ?? undefined,
            senderDisplayName: row.senderDisplayName ?? undefined,
            trust: row.trust,
            createdAt: toIsoTimestamp(row.createdAt),
            receivedAt: row.receivedAt ? toIsoTimestamp(row.receivedAt) : undefined,
            deliveryStatus: row.deliveryStatus ?? undefined,
            deliveredAt: row.deliveredAt
                ? toIsoTimestamp(row.deliveredAt)
                : undefined,
            deliveryError: row.deliveryError ?? undefined,
            parts: parts.map((part) => payloadToMessagePart(part.kind, part.payloadJson)),
            attachments: attachments.map((attachment) => ({
                id: attachment.id,
                messageId: attachment.messageId,
                kind: attachment.kind,
                contentType: attachment.contentType ?? undefined,
                sizeBytes: attachment.sizeBytes ?? undefined,
                externalRef: externalRef(attachment.externalRefJson, 'message_attachment'),
                storageRef: attachment.storageRef ?? undefined,
                trust: attachment.trust,
            })),
        };
    }
}
export class PostgresAgentRunRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getAgentRun(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentRunsPostgres)
            .where(eq(pgSchema.agentRunsPostgres.id, id))
            .limit(1);
        return rows[0] ? this.runFromRow(rows[0]) : null;
    }
    async saveAgentRun(run) {
        assertSafeExecutionProviderId(run.executionProviderId);
        await this.db
            .insert(pgSchema.agentRunsPostgres)
            .values({
            id: run.id,
            appId: run.appId,
            agentId: run.agentId,
            configVersionId: run.configVersionId,
            sessionId: run.sessionId ?? null,
            conversationId: run.conversationId ?? null,
            threadId: run.threadId ?? null,
            messageId: run.messageId ?? null,
            jobId: run.jobId ?? null,
            llmProfileId: run.llmProfileId,
            executionProviderId: run.executionProviderId,
            providerRunId: run.providerRunId ?? null,
            providerSessionId: run.providerSessionId ?? null,
            workerId: run.workerId ?? null,
            leaseOwner: run.leaseOwner ?? null,
            leaseExpiresAt: run.leaseExpiresAt ?? null,
            permissionDecisionIdsJson: encodeJson(run.permissionDecisionIds),
            sandboxLeaseId: run.sandboxLeaseId ?? null,
            workspaceSnapshotId: run.workspaceSnapshotId ?? null,
            cause: run.cause,
            status: run.status,
            createdAt: run.createdAt,
            startedAt: run.startedAt ?? null,
            endedAt: run.endedAt ?? null,
            resultSummary: run.resultSummary ?? null,
            errorSummary: run.errorSummary ?? null,
        })
            .onConflictDoUpdate({
            target: pgSchema.agentRunsPostgres.id,
            set: {
                permissionDecisionIdsJson: encodeJson(run.permissionDecisionIds),
                executionProviderId: run.executionProviderId,
                providerRunId: run.providerRunId ?? null,
                providerSessionId: run.providerSessionId ?? null,
                workerId: run.workerId ?? null,
                leaseOwner: run.leaseOwner ?? null,
                leaseExpiresAt: run.leaseExpiresAt ?? null,
                sandboxLeaseId: run.sandboxLeaseId ?? null,
                workspaceSnapshotId: run.workspaceSnapshotId ?? null,
                status: run.status,
                startedAt: run.startedAt ?? null,
                endedAt: run.endedAt ?? null,
                resultSummary: run.resultSummary ?? null,
                errorSummary: run.errorSummary ?? null,
            },
        });
    }
    async listAgentRunsBySession(input) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentRunsPostgres)
            .where(eq(pgSchema.agentRunsPostgres.sessionId, input.sessionId))
            .orderBy(desc(pgSchema.agentRunsPostgres.createdAt), desc(pgSchema.agentRunsPostgres.id))
            .limit(input.limit ?? 100);
        return rows.map((row) => this.runFromRow(row));
    }
    runFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentId: row.agentId,
            configVersionId: row.configVersionId,
            sessionId: row.sessionId ?? undefined,
            conversationId: row.conversationId ?? undefined,
            threadId: row.threadId ?? undefined,
            messageId: row.messageId ?? undefined,
            jobId: row.jobId ?? undefined,
            llmProfileId: row.llmProfileId,
            executionProviderId: row.executionProviderId,
            providerRunId: row.providerRunId ?? undefined,
            providerSessionId: row.providerSessionId ?? undefined,
            workerId: row.workerId ?? undefined,
            leaseOwner: row.leaseOwner ?? undefined,
            leaseExpiresAt: row.leaseExpiresAt
                ? toIsoTimestamp(row.leaseExpiresAt)
                : undefined,
            permissionDecisionIds: parseJsonArray(row.permissionDecisionIdsJson),
            sandboxLeaseId: row.sandboxLeaseId ?? undefined,
            workspaceSnapshotId: row.workspaceSnapshotId ?? undefined,
            cause: row.cause,
            status: row.status,
            createdAt: toIsoTimestamp(row.createdAt),
            startedAt: row.startedAt ? toIsoTimestamp(row.startedAt) : undefined,
            endedAt: row.endedAt ? toIsoTimestamp(row.endedAt) : undefined,
            resultSummary: row.resultSummary ?? undefined,
            errorSummary: row.errorSummary ?? undefined,
        };
    }
}
export class PostgresPermissionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async savePolicy(policy) {
        await this.db
            .insert(pgSchema.permissionPoliciesPostgres)
            .values(policy)
            .onConflictDoUpdate({
            target: pgSchema.permissionPoliciesPostgres.id,
            set: {
                name: policy.name,
                description: policy.description ?? null,
                status: policy.status,
                updatedAt: policy.updatedAt,
            },
        });
    }
    async saveRule(rule) {
        await this.db
            .insert(pgSchema.permissionRulesPostgres)
            .values({
            id: rule.id,
            appId: rule.appId,
            policyId: rule.policyId,
            priority: rule.priority,
            effect: rule.effect,
            matchJson: encodeJson(rule.match),
            createdAt: rule.createdAt,
            updatedAt: rule.updatedAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.permissionRulesPostgres.id,
            set: {
                priority: rule.priority,
                effect: rule.effect,
                matchJson: encodeJson(rule.match),
                updatedAt: rule.updatedAt,
            },
        });
    }
    async saveDecision(decision) {
        await this.db
            .insert(pgSchema.permissionDecisionsPostgres)
            .values({
            id: decision.id,
            appId: decision.appId,
            policyId: decision.policyId ?? null,
            ruleIdsJson: encodeJson(decision.ruleIds),
            runId: decision.runId ?? null,
            toolId: decision.toolId ?? null,
            effect: decision.effect,
            reason: decision.reason,
            actorContextJson: encodeJsonOrNull(decision.actorContext),
            actionPreview: decision.actionPreview ?? null,
            approverRef: decision.approverRef ?? null,
            expiresAt: decision.expiresAt ?? null,
            createdAt: decision.createdAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.permissionDecisionsPostgres.id,
            set: {
                policyId: decision.policyId ?? null,
                ruleIdsJson: encodeJson(decision.ruleIds),
                runId: decision.runId ?? null,
                toolId: decision.toolId ?? null,
                effect: decision.effect,
                reason: decision.reason,
                actorContextJson: encodeJsonOrNull(decision.actorContext),
                actionPreview: decision.actionPreview ?? null,
                approverRef: decision.approverRef ?? null,
                expiresAt: decision.expiresAt ?? null,
            },
        });
    }
    async getDecision(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.permissionDecisionsPostgres)
            .where(eq(pgSchema.permissionDecisionsPostgres.id, id))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return {
            id: row.id,
            appId: row.appId,
            policyId: row.policyId ?? undefined,
            ruleIds: parseJsonArray(row.ruleIdsJson),
            runId: row.runId ?? undefined,
            toolId: row.toolId ?? undefined,
            effect: row.effect,
            reason: row.reason,
            actorContext: row.actorContextJson
                ? parseJson(row.actorContextJson, {})
                : undefined,
            actionPreview: row.actionPreview ?? undefined,
            approverRef: row.approverRef ?? undefined,
            expiresAt: row.expiresAt ?? undefined,
            createdAt: row.createdAt,
        };
    }
}
export class PostgresSandboxRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getSandboxProfile(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.sandboxProfilesPostgres)
            .where(eq(pgSchema.sandboxProfilesPostgres.id, id))
            .limit(1);
        return rows[0] ?? null;
    }
    async saveSandboxProfile(profile) {
        await this.db
            .insert(pgSchema.sandboxProfilesPostgres)
            .values(profile)
            .onConflictDoUpdate({
            target: pgSchema.sandboxProfilesPostgres.id,
            set: {
                name: profile.name,
                filesystem: profile.filesystem,
                network: profile.network,
                process: profile.process,
                browser: profile.browser,
                credentialAccess: profile.credentialAccess,
                timeoutMs: profile.timeoutMs,
                updatedAt: profile.updatedAt,
            },
        });
    }
    async getSandboxLease(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.sandboxLeasesPostgres)
            .where(eq(pgSchema.sandboxLeasesPostgres.id, id))
            .limit(1);
        return rows[0] ?? null;
    }
    async saveSandboxLease(lease) {
        await this.db
            .insert(pgSchema.sandboxLeasesPostgres)
            .values({
            id: lease.id,
            appId: lease.appId,
            profileId: lease.profileId,
            runId: lease.runId,
            permissionDecisionId: lease.permissionDecisionId,
            status: lease.status,
            grantedAt: lease.grantedAt,
            expiresAt: lease.expiresAt,
            releasedAt: lease.releasedAt ?? null,
        })
            .onConflictDoUpdate({
            target: pgSchema.sandboxLeasesPostgres.id,
            set: {
                status: lease.status,
                releasedAt: lease.releasedAt ?? null,
            },
        });
    }
    async saveWorkspaceSnapshot(snapshot) {
        await this.db
            .insert(pgSchema.workspaceSnapshotsPostgres)
            .values({
            id: snapshot.id,
            appId: snapshot.appId,
            rootRef: snapshot.rootRef,
            mountsJson: encodeJson(snapshot.mounts),
            promptRefsJson: encodeJson(snapshot.promptRefs),
            contextRefsJson: encodeJson(snapshot.contextRefs),
            createdAt: snapshot.createdAt,
        })
            .onConflictDoNothing();
    }
    async getWorkspaceSnapshot(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.workspaceSnapshotsPostgres)
            .where(eq(pgSchema.workspaceSnapshotsPostgres.id, id))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return {
            id: row.id,
            appId: row.appId,
            rootRef: row.rootRef,
            mounts: parseJson(row.mountsJson, []),
            promptRefs: parseJsonArray(row.promptRefsJson),
            contextRefs: parseJsonArray(row.contextRefsJson),
            createdAt: row.createdAt,
        };
    }
}
export function createPostgresDomainRepositories(db, _pool, options = {}) {
    return {
        apps: new PostgresAppRepository(db),
        agents: new PostgresAgentRepository(db),
        agentConfigs: new PostgresAgentConfigRepository(db),
        providerAccounts: new PostgresProviderAccountRepository(db),
        conversations: new PostgresConversationRepository(db),
        messages: new PostgresMessageRepository(db),
        agentSessions: new PostgresAgentSessionRepository(db),
        agentSessionDigests: new PostgresAgentSessionDigestRepository(db),
        providerSessions: new PostgresProviderSessionRepository(db),
        agentSessionSummaries: new PostgresAgentSessionSummaryRepository(db),
        agentRuns: new PostgresAgentRunRepository(db),
        runtimeEvents: new PostgresRuntimeEventRepository(db, undefined, options.maxLiveAdmissionBacklog),
        tools: new PostgresToolCatalogRepository(db),
        skills: new PostgresSkillCatalogRepository(db),
        capabilitySecrets: new PostgresCapabilitySecretRepository(db),
        modelCredentials: new PostgresModelCredentialRepository(db),
        mcpServers: new PostgresMcpServerRepository(db),
        permissions: new PostgresPermissionRepository(db),
        pendingAccessRequests: new PostgresPendingAccessRequestsRepository(db),
        sandboxes: new PostgresSandboxRepository(db),
        outboundDeliveries: new PostgresOutboundDeliveryRepository(db),
        workerCoordination: new PostgresWorkerCoordinationRepository(db, options.liveTurnCommandNotifier),
        liveTurns: new PostgresLiveTurnRepository(db, options.liveTurnCommandNotifier, options.maxLiveAdmissionBacklog),
        runtimeDependencies: new PostgresRuntimeDependencyRepository(db),
        settingsRevisions: new PostgresSettingsRevisionRepository(db),
        asyncTasks: new PostgresAsyncTaskRepository(db),
        patternCandidates: new PostgresPatternCandidateRepository(db),
        proactiveSurfacing: new PostgresProactiveSurfacingRepository(db),
        observerInsights: new PostgresObserverInsightRepository(db),
        chatBatches: new PostgresChatBatchRepository(db),
        permissionPromotions: new PostgresPermissionPromotionRepository(db),
        permissionDecisionMemory: new PostgresPermissionDecisionMemoryRepository(db),
        groupJoinOnboarding: new PostgresGroupJoinOnboardingRepository(db),
    };
}
