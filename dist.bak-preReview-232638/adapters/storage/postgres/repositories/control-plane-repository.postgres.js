import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { mapDelivery, mapRoute, mapSession, mapWebhook, text, } from '../schema/control-plane-canonical.postgres.js';
import { jsonb, } from './canonical-graph-repository.postgres.js';
import { ensureControlGraph } from './control-plane-graph.postgres.js';
import { PostgresExternalIngressRepository } from './control-plane-external-ingress.postgres.js';
import { PostgresJobTriggerRepository } from './control-plane-job-triggers.postgres.js';
import { getControlSessionByChatJid, getControlSessionById, getControlSessionsByChatJids, getControlSessionsByIds, } from './control-plane-sessions.postgres.js';
import { claimDueWebhookDeliveriesWithDrizzleLock } from './control-plane-webhook-claim.postgres.js';
export class PostgresControlPlaneRepository {
    db;
    externalIngress;
    jobTriggers;
    constructor(db) {
        this.db = db;
        this.externalIngress = new PostgresExternalIngressRepository(db);
        this.jobTriggers = new PostgresJobTriggerRepository(db);
    }
    async ensureAppSession(input) {
        const workspaceKey = input.workspaceFolder;
        return this.db.transaction(async (tx) => {
            const graph = await ensureControlGraph(tx, {
                appId: input.appId,
                externalConversationId: input.conversationId,
                externalConversationRef: input.chatJid,
                agentFolder: workspaceKey,
                title: input.title,
            });
            const now = currentIso();
            const [existing] = await tx
                .select()
                .from(pgSchema.controlHttpSessionsPostgres)
                .where(and(eq(pgSchema.controlHttpSessionsPostgres.appId, input.appId), eq(pgSchema.controlHttpSessionsPostgres.externalConversationId, input.conversationId)))
                .limit(1);
            const sessionId = text(existing?.sessionId) ?? randomUUID();
            await tx
                .insert(pgSchema.agentSessionsPostgres)
                .values({
                id: sessionId,
                appId: input.appId,
                agentId: graph.agentId,
                conversationId: graph.conversationId,
                status: 'active',
                model: null,
                createdAt: now,
                updatedAt: now,
            })
                .onConflictDoUpdate({
                target: pgSchema.agentSessionsPostgres.id,
                set: {
                    agentId: graph.agentId,
                    conversationId: graph.conversationId,
                    updatedAt: now,
                },
            });
            const rows = await tx
                .insert(pgSchema.controlHttpSessionsPostgres)
                .values({
                sessionId,
                appId: input.appId,
                externalConversationId: input.conversationId,
                conversationId: graph.conversationId,
                agentId: graph.agentId,
                defaultResponseMode: input.defaultResponseMode ?? 'sse',
                defaultWebhookId: input.defaultWebhookId ?? null,
                externalRefJson: jsonb({
                    externalConversationId: input.conversationId,
                    chatJid: input.chatJid,
                    workspaceFolder: workspaceKey,
                    title: input.title ?? null,
                }),
                createdAt: now,
                updatedAt: now,
            })
                .onConflictDoUpdate({
                target: [
                    pgSchema.controlHttpSessionsPostgres.appId,
                    pgSchema.controlHttpSessionsPostgres.externalConversationId,
                ],
                set: {
                    conversationId: graph.conversationId,
                    agentId: graph.agentId,
                    defaultResponseMode: input.defaultResponseMode ?? 'sse',
                    defaultWebhookId: input.defaultWebhookId ?? null,
                    externalRefJson: jsonb({
                        externalConversationId: input.conversationId,
                        chatJid: input.chatJid,
                        workspaceFolder: workspaceKey,
                        title: input.title ?? null,
                    }),
                    updatedAt: now,
                },
            })
                .returning();
            return mapSession(rows[0]);
        });
    }
    async getAppSessionById(sessionId) {
        return getControlSessionById(this.db, sessionId);
    }
    async getAppSessionsByIds(sessionIds) {
        return getControlSessionsByIds(this.db, sessionIds);
    }
    async getAppSessionByChatJid(chatJid) {
        return getControlSessionByChatJid(this.db, chatJid);
    }
    async getAppSessionsByChatJids(chatJids) {
        return getControlSessionsByChatJids(this.db, chatJids);
    }
    async upsertAppResponseRoute(input) {
        const rows = await this.db
            .insert(pgSchema.controlHttpResponseRoutesPostgres)
            .values({
            sessionId: input.sessionId,
            threadId: input.threadId?.trim() || '',
            responseMode: input.responseMode,
            webhookId: input.webhookId ?? null,
            correlationId: input.correlationId ?? null,
            updatedAt: currentIso(),
        })
            .onConflictDoUpdate({
            target: [
                pgSchema.controlHttpResponseRoutesPostgres.sessionId,
                pgSchema.controlHttpResponseRoutesPostgres.threadId,
            ],
            set: {
                responseMode: input.responseMode,
                webhookId: input.webhookId ?? null,
                correlationId: input.correlationId ?? null,
                updatedAt: currentIso(),
            },
        })
            .returning();
        return mapRoute(rows[0]);
    }
    async getAppResponseRoute(input) {
        const rows = await this.db
            .select()
            .from(pgSchema.controlHttpResponseRoutesPostgres)
            .where(and(eq(pgSchema.controlHttpResponseRoutesPostgres.sessionId, input.sessionId), eq(pgSchema.controlHttpResponseRoutesPostgres.threadId, input.threadId?.trim() || '')))
            .limit(1);
        return rows[0] ? mapRoute(rows[0]) : undefined;
    }
    async createExternalIngress(input) {
        return this.externalIngress.create(input);
    }
    async listExternalIngresses(appId) {
        return this.externalIngress.list(appId);
    }
    async getExternalIngressById(ingressId, appId) {
        return this.externalIngress.getById(ingressId, appId);
    }
    async updateExternalIngress(ingressId, appId, patch) {
        return this.externalIngress.update(ingressId, appId, patch);
    }
    async deleteExternalIngress(ingressId, appId) {
        return this.externalIngress.delete(ingressId, appId);
    }
    async reserveExternalIngressNonce(input) {
        return this.externalIngress.reserveNonce(input);
    }
    async createExternalIngressInvocation(input) {
        return this.externalIngress.createInvocation(input);
    }
    async getExternalIngressInvocationByIdempotencyKey(input) {
        return this.externalIngress.getInvocationByIdempotencyKey(input);
    }
    async updateExternalIngressInvocation(input) {
        await this.externalIngress.updateInvocation(input);
    }
    async getExternalIngressInvocation(invocationId, appId, ingressId) {
        return this.externalIngress.getInvocation(invocationId, appId, ingressId);
    }
    async sweepExpiredExternalIngressState(input) {
        return this.externalIngress.sweepExpiredState(input);
    }
    async registerWebhook(input) {
        await ensureControlGraph(this.db, {
            appId: input.appId,
            externalConversationId: 'webhooks',
            externalConversationRef: 'webhooks',
            agentFolder: 'control',
        });
        const now = currentIso();
        const rows = await this.db
            .insert(pgSchema.controlHttpWebhooksPostgres)
            .values({
            webhookId: input.webhookId ?? randomUUID(),
            appId: input.appId,
            name: input.name,
            url: input.url,
            secret: input.secret,
            enabled: input.enabled ?? true,
            eventTypes: input.eventTypes ? [...input.eventTypes] : null,
            agentId: input.agentId ?? null,
            sessionId: input.sessionId ?? null,
            jobId: input.jobId ?? null,
            createdAt: now,
            updatedAt: now,
        })
            .onConflictDoUpdate({
            target: pgSchema.controlHttpWebhooksPostgres.webhookId,
            set: {
                appId: input.appId,
                name: input.name,
                url: input.url,
                secret: input.secret,
                enabled: input.enabled ?? true,
                eventTypes: input.eventTypes ? [...input.eventTypes] : null,
                agentId: input.agentId ?? null,
                sessionId: input.sessionId ?? null,
                jobId: input.jobId ?? null,
                updatedAt: now,
            },
        })
            .returning();
        return mapWebhook(rows[0]);
    }
    async getWebhookById(webhookId, appId) {
        const conditions = [
            eq(pgSchema.controlHttpWebhooksPostgres.webhookId, webhookId),
        ];
        if (appId)
            conditions.push(eq(pgSchema.controlHttpWebhooksPostgres.appId, appId));
        const rows = await this.db
            .select()
            .from(pgSchema.controlHttpWebhooksPostgres)
            .where(and(...conditions))
            .limit(1);
        const row = rows[0];
        return row
            ? {
                ...mapWebhook(row),
                secret: String(row.secret),
            }
            : undefined;
    }
    async listWebhooks(appId) {
        const query = this.db
            .select()
            .from(pgSchema.controlHttpWebhooksPostgres)
            .$dynamic();
        const rows = await (appId
            ? query.where(eq(pgSchema.controlHttpWebhooksPostgres.appId, appId))
            : query).orderBy(desc(pgSchema.controlHttpWebhooksPostgres.updatedAt));
        return rows.map((row) => mapWebhook(row));
    }
    async updateWebhook(webhookId, appId, patch) {
        const existing = await this.getWebhookById(webhookId, appId);
        if (!existing)
            return undefined;
        const rows = await this.db
            .update(pgSchema.controlHttpWebhooksPostgres)
            .set({
            name: patch.name ?? existing.name,
            url: patch.url ?? existing.url,
            secret: patch.secret ?? existing.secret,
            enabled: patch.enabled ?? existing.enabled,
            eventTypes: patch.eventTypes === undefined
                ? existing.eventTypes
                : patch.eventTypes
                    ? [...patch.eventTypes]
                    : null,
            agentId: patch.agentId === undefined ? existing.agentId : patch.agentId,
            sessionId: patch.sessionId === undefined ? existing.sessionId : patch.sessionId,
            jobId: patch.jobId === undefined ? existing.jobId : patch.jobId,
            updatedAt: currentIso(),
        })
            .where(and(eq(pgSchema.controlHttpWebhooksPostgres.webhookId, webhookId), eq(pgSchema.controlHttpWebhooksPostgres.appId, appId)))
            .returning();
        return rows[0] ? mapWebhook(rows[0]) : undefined;
    }
    async deleteWebhook(webhookId, appId) {
        const conditions = [
            eq(pgSchema.controlHttpWebhooksPostgres.webhookId, webhookId),
        ];
        if (appId)
            conditions.push(eq(pgSchema.controlHttpWebhooksPostgres.appId, appId));
        await this.db
            .delete(pgSchema.controlHttpWebhooksPostgres)
            .where(and(...conditions));
    }
    async enqueueWebhookDelivery(eventId, webhookId) {
        const now = currentIso();
        const rows = await this.db
            .insert(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .values({
            deliveryId: randomUUID(),
            webhookId,
            eventId,
            status: 'pending',
            attemptCount: 0,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
        })
            .onConflictDoNothing({
            target: [
                pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId,
                pgSchema.controlHttpWebhookDeliveriesPostgres.eventId,
            ],
        })
            .returning();
        if (rows[0])
            return mapDelivery(rows[0]);
        const existing = await this.db
            .select()
            .from(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .where(and(eq(pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId, webhookId), eq(pgSchema.controlHttpWebhookDeliveriesPostgres.eventId, eventId)))
            .limit(1);
        return mapDelivery(existing[0]);
    }
    async listDueWebhookDeliveries(limit = 50) {
        const rows = await this.db
            .select()
            .from(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .where(and(inArray(pgSchema.controlHttpWebhookDeliveriesPostgres.status, [
            'pending',
            'retrying',
            'delivering',
        ]), sql `${pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt} <= ${currentIso()}`))
            .orderBy(asc(pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt), asc(pgSchema.controlHttpWebhookDeliveriesPostgres.createdAt))
            .limit(limit);
        return rows.map((row) => mapDelivery(row));
    }
    async claimDueWebhookDeliveries(limit = 50) {
        return claimDueWebhookDeliveriesWithDrizzleLock(this.db, limit);
    }
    async markWebhookDeliveryDelivered(deliveryId) {
        await this.db
            .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .set({
            status: 'delivered',
            deliveredAt: currentIso(),
            lastAttemptAt: currentIso(),
            updatedAt: currentIso(),
            lastError: null,
        })
            .where(eq(pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId, deliveryId));
    }
    async markWebhookDeliveryDelivering(input) {
        await this.db
            .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .set({
            status: 'delivering',
            attemptCount: input.attemptCount,
            nextAttemptAt: input.nextAttemptAt,
            lastAttemptAt: currentIso(),
            updatedAt: currentIso(),
            lastError: null,
        })
            .where(eq(pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId, input.deliveryId));
    }
    async markWebhookDeliveryRetry(input) {
        await this.db
            .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .set({
            status: 'retrying',
            nextAttemptAt: input.nextAttemptAt,
            updatedAt: currentIso(),
            lastError: input.lastError,
        })
            .where(eq(pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId, input.deliveryId));
    }
    async markWebhookDeliveryDead(deliveryId, lastError) {
        await this.db
            .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .set({
            status: 'dead_lettered',
            lastAttemptAt: currentIso(),
            updatedAt: currentIso(),
            lastError,
        })
            .where(eq(pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId, deliveryId));
    }
    async replayWebhookDeadLetters(webhookId, appId) {
        const webhook = await this.getWebhookById(webhookId, appId);
        if (!webhook)
            return 0;
        const rows = await this.db
            .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .set({
            status: 'pending',
            nextAttemptAt: currentIso(),
            updatedAt: currentIso(),
        })
            .where(and(eq(pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId, webhookId), eq(pgSchema.controlHttpWebhookDeliveriesPostgres.status, 'dead_lettered')))
            .returning({
            deliveryId: pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
        });
        return rows.length;
    }
    async purgeWebhookDeadLetters(webhookId, appId) {
        const webhook = await this.getWebhookById(webhookId, appId);
        if (!webhook)
            return 0;
        const rows = await this.db
            .delete(pgSchema.controlHttpWebhookDeliveriesPostgres)
            .where(and(eq(pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId, webhookId), eq(pgSchema.controlHttpWebhookDeliveriesPostgres.status, 'dead_lettered')))
            .returning({
            deliveryId: pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
        });
        return rows.length;
    }
    async createJobTrigger(input) {
        return this.jobTriggers.create(input);
    }
    async bindPendingTriggerToRun(jobId, runId) {
        return this.jobTriggers.bindPendingToRun(jobId, runId);
    }
    async bindTriggerToRun(triggerId, runId) {
        return this.jobTriggers.bindToRun(triggerId, runId);
    }
    async markTriggerCompleted(triggerId, status) {
        await this.jobTriggers.markCompleted(triggerId, status);
    }
    async getTriggerById(triggerId) {
        return this.jobTriggers.getById(triggerId);
    }
}
