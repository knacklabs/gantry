import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
import { jsonb, } from './canonical-graph-repository.postgres.js';
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
        if (!(err instanceof SyntaxError))
            throw err;
        return fallback;
    }
}
function isUniqueViolation(err) {
    if (typeof err !== 'object' || err === null)
        return false;
    if ('code' in err && err.code === '23505')
        return true;
    if ('cause' in err)
        return isUniqueViolation(err.cause);
    return false;
}
function externalRef(value, fallbackKind, fallbackValue) {
    const parsed = parseJson(value, {});
    if (typeof parsed.kind === 'string' && typeof parsed.value === 'string') {
        return { kind: parsed.kind, value: parsed.value };
    }
    return fallbackValue
        ? { kind: fallbackKind, value: fallbackValue }
        : undefined;
}
function providerFromProviderRef(ref) {
    const idx = ref.value.indexOf(':');
    if (idx <= 0) {
        throw new Error(`Provider session ref must be prefixed as "<provider>:<external-session-id>"; received ${ref.value}`);
    }
    return ref.value.slice(0, idx);
}
function externalSessionIdFromProviderRef(ref) {
    const idx = ref.value.indexOf(':');
    return idx > 0 ? ref.value.slice(idx + 1) : ref.value;
}
function scopedValue(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
function digestScopeFromMetadata(metadata) {
    const scope = metadata?.sessionScope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
        return {
            appId: null,
            agentId: null,
            conversationId: null,
            userId: null,
            threadId: null,
            jobId: null,
        };
    }
    const record = scope;
    return {
        appId: scopedValue(record.appId),
        agentId: scopedValue(record.agentId),
        conversationId: scopedValue(record.conversationId),
        userId: scopedValue(record.userId),
        threadId: scopedValue(record.threadId),
        jobId: scopedValue(record.jobId),
    };
}
function scopePredicate(column, value) {
    return value === null ? isNull(column) : eq(column, value);
}
export class PostgresAgentSessionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getAgentSession(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentSessionsPostgres)
            .where(eq(pgSchema.agentSessionsPostgres.id, id))
            .limit(1);
        return rows[0] ? this.sessionFromRow(rows[0]) : null;
    }
    async getAgentSessionByKey(input) {
        const s = pgSchema.agentSessionsPostgres;
        const rows = await this.db
            .select()
            .from(s)
            .where(and(eq(s.appId, input.appId), eq(s.agentId, input.agentId), eq(s.conversationId, input.conversationId), input.threadId ? eq(s.threadId, input.threadId) : isNull(s.threadId), input.userId ? eq(s.userId, input.userId) : isNull(s.userId), isNull(s.jobId)))
            .orderBy(desc(s.updatedAt), desc(s.id))
            .limit(1);
        return rows[0] ? this.sessionFromRow(rows[0]) : null;
    }
    async saveAgentSession(session) {
        try {
            await this.writeAgentSession(session);
        }
        catch (err) {
            if (!isUniqueViolation(err) || !session.conversationId || session.jobId) {
                throw err;
            }
            const existing = await this.getAgentSessionByKey({
                appId: session.appId,
                agentId: session.agentId,
                conversationId: session.conversationId,
                threadId: session.threadId,
                userId: session.userId,
            });
            if (!existing)
                throw err;
            await this.writeAgentSession({ ...session, id: existing.id });
        }
    }
    async writeAgentSession(session) {
        await this.db
            .insert(pgSchema.agentSessionsPostgres)
            .values({
            id: session.id,
            appId: session.appId,
            agentId: session.agentId,
            conversationId: session.conversationId ?? null,
            threadId: session.threadId ?? null,
            jobId: session.jobId ?? null,
            userId: session.userId ?? null,
            status: session.status,
            model: session.model ?? null,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            resetAt: session.resetAt ?? null,
        })
            .onConflictDoUpdate({
            target: pgSchema.agentSessionsPostgres.id,
            set: {
                status: session.status,
                model: session.model ?? null,
                updatedAt: session.updatedAt,
                resetAt: session.resetAt ?? null,
            },
        });
    }
    sessionFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentId: row.agentId,
            conversationId: row.conversationId ?? undefined,
            threadId: row.threadId ?? undefined,
            jobId: row.jobId ?? undefined,
            userId: row.userId ?? undefined,
            status: row.status,
            model: row.model ?? undefined,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            resetAt: row.resetAt ?? undefined,
        };
    }
}
export class PostgresProviderSessionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getProviderSession(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.providerSessionsPostgres)
            .where(eq(pgSchema.providerSessionsPostgres.id, id))
            .limit(1);
        return rows[0] ? this.providerSessionFromRow(rows[0]) : null;
    }
    async getLatestProviderSession(input) {
        const ps = pgSchema.providerSessionsPostgres;
        const rows = await this.db
            .select()
            .from(ps)
            .where(and(eq(ps.agentSessionId, input.agentSessionId), eq(ps.status, 'active'), input.provider ? eq(ps.provider, input.provider) : undefined))
            .orderBy(desc(ps.updatedAt), desc(ps.createdAt), desc(ps.id))
            .limit(1);
        return rows[0] ? this.providerSessionFromRow(rows[0]) : null;
    }
    async saveProviderSession(session) {
        const provider = session.provider || providerFromProviderRef(session.providerRef);
        const externalSessionId = session.externalSessionId ||
            externalSessionIdFromProviderRef(session.providerRef);
        await this.db.transaction(async (tx) => {
            await tx
                .insert(pgSchema.providerSessionsPostgres)
                .values({
                id: session.id,
                appId: session.appId,
                agentSessionId: session.agentSessionId,
                provider,
                externalSessionId,
                providerRefJson: jsonb(session.providerRef),
                metadataJson: jsonb(session.metadata ?? {}),
                status: session.status,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
            })
                .onConflictDoNothing();
            const [existing] = await tx
                .select({
                appId: pgSchema.providerSessionsPostgres.appId,
                agentSessionId: pgSchema.providerSessionsPostgres.agentSessionId,
                provider: pgSchema.providerSessionsPostgres.provider,
                externalSessionId: pgSchema.providerSessionsPostgres.externalSessionId,
            })
                .from(pgSchema.providerSessionsPostgres)
                .where(eq(pgSchema.providerSessionsPostgres.id, session.id))
                .for('update')
                .limit(1);
            if (!existing ||
                existing.appId !== session.appId ||
                existing.agentSessionId !== session.agentSessionId ||
                existing.provider !== provider ||
                existing.externalSessionId !== externalSessionId) {
                throw new Error(`Provider session id is already owned by another session: ${session.id}`);
            }
            await tx
                .update(pgSchema.providerSessionsPostgres)
                .set({
                provider,
                externalSessionId,
                providerRefJson: jsonb(session.providerRef),
                metadataJson: jsonb(session.metadata ?? {}),
                status: session.status,
                updatedAt: session.updatedAt,
            })
                .where(and(eq(pgSchema.providerSessionsPostgres.id, session.id), eq(pgSchema.providerSessionsPostgres.appId, session.appId), eq(pgSchema.providerSessionsPostgres.agentSessionId, session.agentSessionId), eq(pgSchema.providerSessionsPostgres.provider, provider), eq(pgSchema.providerSessionsPostgres.externalSessionId, externalSessionId)));
            await tx
                .update(pgSchema.agentSessionsPostgres)
                .set({
                latestProviderSessionId: session.id,
                updatedAt: session.updatedAt,
            })
                .where(and(eq(pgSchema.agentSessionsPostgres.id, session.agentSessionId), or(isNull(pgSchema.agentSessionsPostgres.latestProviderSessionId), sql `NOT EXISTS (
                SELECT 1
                FROM ${pgSchema.providerSessionsPostgres} latest
                WHERE latest.id = ${pgSchema.agentSessionsPostgres.latestProviderSessionId}
                  AND latest.updated_at > ${session.updatedAt}
              )`)));
        });
    }
    async markProviderSessionStatus(id, status, updatedAt) {
        await this.db
            .update(pgSchema.providerSessionsPostgres)
            .set({ status, updatedAt })
            .where(eq(pgSchema.providerSessionsPostgres.id, id));
    }
    providerSessionFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentSessionId: row.agentSessionId,
            provider: row.provider,
            externalSessionId: row.externalSessionId,
            providerRef: externalRef(row.providerRefJson, 'provider_session', `${row.provider}:${row.externalSessionId}`) ??
                {
                    kind: 'provider_session',
                    value: `${row.provider}:${row.externalSessionId}`,
                },
            metadata: parseJson(row.metadataJson, {}),
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}
export class PostgresAgentSessionSummaryRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getAgentSessionSummary(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentSessionSummariesPostgres)
            .where(eq(pgSchema.agentSessionSummariesPostgres.id, id))
            .limit(1);
        return rows[0] ? this.summaryFromRow(rows[0]) : null;
    }
    async getLatestAgentSessionSummary(agentSessionId) {
        const s = pgSchema.agentSessionSummariesPostgres;
        const rows = await this.db
            .select()
            .from(s)
            .where(eq(s.agentSessionId, agentSessionId))
            .orderBy(desc(s.createdAt), desc(s.id))
            .limit(1);
        return rows[0] ? this.summaryFromRow(rows[0]) : null;
    }
    async listRecentAgentSessionSummaries(input) {
        const s = pgSchema.agentSessionSummariesPostgres;
        const rows = await this.db
            .select()
            .from(s)
            .where(eq(s.agentSessionId, input.agentSessionId))
            .orderBy(desc(s.createdAt), desc(s.id))
            .limit(Math.max(1, Math.min(input.limit ?? 3, 10)));
        return rows.map((row) => this.summaryFromRow(row));
    }
    async saveAgentSessionSummary(summary) {
        await this.db
            .insert(pgSchema.agentSessionSummariesPostgres)
            .values({
            id: summary.id,
            appId: summary.appId,
            agentSessionId: summary.agentSessionId,
            summary: summary.summary,
            source: summary.source,
            fromMessageId: summary.fromMessageId ?? null,
            toMessageId: summary.toMessageId ?? null,
            fromRunId: summary.fromRunId ?? null,
            toRunId: summary.toRunId ?? null,
            messageCount: summary.messageCount,
            runCount: summary.runCount,
            createdAt: summary.createdAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.agentSessionSummariesPostgres.id,
            set: {
                summary: summary.summary,
                source: summary.source,
                fromMessageId: summary.fromMessageId ?? null,
                toMessageId: summary.toMessageId ?? null,
                fromRunId: summary.fromRunId ?? null,
                toRunId: summary.toRunId ?? null,
                messageCount: summary.messageCount,
                runCount: summary.runCount,
            },
        });
    }
    summaryFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentSessionId: row.agentSessionId,
            summary: row.summary,
            source: row.source,
            fromMessageId: row.fromMessageId ?? undefined,
            toMessageId: row.toMessageId ?? undefined,
            fromRunId: row.fromRunId ?? undefined,
            toRunId: row.toRunId ?? undefined,
            messageCount: row.messageCount,
            runCount: row.runCount,
            createdAt: row.createdAt,
        };
    }
}
export class PostgresAgentSessionDigestRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getAgentSessionDigest(id) {
        const rows = await this.db
            .select()
            .from(pgSchema.agentSessionDigestsPostgres)
            .where(eq(pgSchema.agentSessionDigestsPostgres.id, id))
            .limit(1);
        return rows[0] ? this.digestFromRow(rows[0]) : null;
    }
    async listAgentSessionDigests(input) {
        const d = pgSchema.agentSessionDigestsPostgres;
        const sessionScope = input.sessionScope;
        const rows = await this.db
            .select()
            .from(d)
            .where(and(eq(d.agentSessionId, input.agentSessionId), input.trigger ? eq(d.trigger, input.trigger) : undefined, sessionScope
            ? scopePredicate(d.scopeAppId, sessionScope.appId)
            : undefined, sessionScope
            ? scopePredicate(d.scopeAgentId, sessionScope.agentId)
            : undefined, sessionScope
            ? scopePredicate(d.scopeConversationId, sessionScope.conversationId)
            : undefined, sessionScope
            ? scopePredicate(d.scopeUserId, sessionScope.userId)
            : undefined, sessionScope
            ? scopePredicate(d.scopeThreadId, sessionScope.threadId)
            : undefined))
            .orderBy(desc(d.createdAt), desc(d.id))
            .limit(Math.max(1, Math.min(input.limit ?? 20, 200)));
        return rows.map((row) => this.digestFromRow(row));
    }
    async saveAgentSessionDigest(digest) {
        const scope = digestScopeFromMetadata(digest.metadata);
        await this.db
            .insert(pgSchema.agentSessionDigestsPostgres)
            .values({
            id: digest.id,
            appId: digest.appId,
            agentSessionId: digest.agentSessionId,
            trigger: digest.trigger,
            digest: digest.digest,
            messageCount: digest.messageCount,
            extractedFactCount: digest.extractedFactCount,
            metadataJson: jsonb(digest.metadata ?? {}),
            scopeAppId: scope.appId,
            scopeAgentId: scope.agentId,
            scopeConversationId: scope.conversationId,
            scopeUserId: scope.userId,
            scopeThreadId: scope.threadId,
            createdAt: digest.createdAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.agentSessionDigestsPostgres.id,
            set: {
                trigger: digest.trigger,
                digest: digest.digest,
                messageCount: digest.messageCount,
                extractedFactCount: digest.extractedFactCount,
                metadataJson: jsonb(digest.metadata ?? {}),
                scopeAppId: scope.appId,
                scopeAgentId: scope.agentId,
                scopeConversationId: scope.conversationId,
                scopeUserId: scope.userId,
                scopeThreadId: scope.threadId,
            },
        });
    }
    digestFromRow(row) {
        return {
            id: row.id,
            appId: row.appId,
            agentSessionId: row.agentSessionId,
            trigger: row.trigger,
            digest: row.digest,
            messageCount: row.messageCount,
            extractedFactCount: row.extractedFactCount,
            metadata: parseJson(row.metadataJson, {}),
            createdAt: row.createdAt,
        };
    }
}
