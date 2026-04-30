import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type {
  AppResponseRouteRecord,
  AppSessionRecord,
  ClaimedWebhookDeliveryRecord,
  ControlResponseMode,
  JobTriggerRecord,
  WebhookDeliveryRecord,
  WebhookRegistrationRecord,
} from '../schema/control-plane-records.postgres.js';
import {
  mapDelivery,
  mapRoute,
  mapSession,
  mapTrigger,
  mapWebhook,
  text,
  type CanonicalControlRow,
} from '../schema/control-plane-canonical.postgres.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { ensureControlGraph } from './control-plane-graph.postgres.js';
import { claimDueWebhookDeliveriesWithDrizzleLock } from './control-plane-webhook-claim.postgres.js';

export class PostgresControlPlaneRepository {
  constructor(private readonly db: CanonicalDb) {}

  async ensureAppSession(input: {
    appId: string;
    conversationId: string;
    chatJid: string;
    groupFolder: string;
    title?: string | null;
    defaultResponseMode?: ControlResponseMode;
    defaultWebhookId?: string | null;
  }): Promise<AppSessionRecord> {
    const workspaceKey = input.groupFolder;
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
        .where(
          and(
            eq(pgSchema.controlHttpSessionsPostgres.appId, input.appId),
            eq(
              pgSchema.controlHttpSessionsPostgres.externalConversationId,
              input.conversationId,
            ),
          ),
        )
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
          modelOverride: null,
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
          externalRefJson: JSON.stringify({
            externalConversationId: input.conversationId,
            chatJid: input.chatJid,
            groupFolder: workspaceKey,
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
            externalRefJson: JSON.stringify({
              externalConversationId: input.conversationId,
              chatJid: input.chatJid,
              groupFolder: workspaceKey,
              title: input.title ?? null,
            }),
            updatedAt: now,
          },
        })
        .returning();
      return mapSession(rows[0] as CanonicalControlRow);
    });
  }

  async getAppSessionById(
    sessionId: string,
  ): Promise<AppSessionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.controlHttpSessionsPostgres)
      .where(eq(pgSchema.controlHttpSessionsPostgres.sessionId, sessionId))
      .limit(1);
    return rows[0] ? mapSession(rows[0] as CanonicalControlRow) : undefined;
  }

  async getAppSessionByChatJid(
    chatJid: string,
  ): Promise<AppSessionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.controlHttpSessionsPostgres)
      .where(
        sql`${pgSchema.controlHttpSessionsPostgres.externalRefJson}::jsonb->>'chatJid' = ${chatJid}`,
      )
      .limit(1);
    return rows[0] ? mapSession(rows[0] as CanonicalControlRow) : undefined;
  }

  async upsertAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
    responseMode: ControlResponseMode;
    webhookId?: string | null;
    correlationId?: string | null;
  }): Promise<AppResponseRouteRecord> {
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
    return mapRoute(rows[0] as CanonicalControlRow);
  }

  async getAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
  }): Promise<AppResponseRouteRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.controlHttpResponseRoutesPostgres)
      .where(
        and(
          eq(
            pgSchema.controlHttpResponseRoutesPostgres.sessionId,
            input.sessionId,
          ),
          eq(
            pgSchema.controlHttpResponseRoutesPostgres.threadId,
            input.threadId?.trim() || '',
          ),
        ),
      )
      .limit(1);
    return rows[0] ? mapRoute(rows[0] as CanonicalControlRow) : undefined;
  }

  async registerWebhook(input: {
    webhookId?: string;
    appId: string;
    name: string;
    url: string;
    secret: string;
    enabled?: boolean;
  }): Promise<WebhookRegistrationRecord> {
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
          updatedAt: now,
        },
      })
      .returning();
    return mapWebhook(rows[0] as CanonicalControlRow);
  }

  async getWebhookById(
    webhookId: string,
    appId?: string,
  ): Promise<(WebhookRegistrationRecord & { secret: string }) | undefined> {
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
    const row = rows[0] as CanonicalControlRow | undefined;
    return row
      ? {
          ...mapWebhook(row),
          secret: String(row.secret),
        }
      : undefined;
  }

  async listWebhooks(appId?: string): Promise<WebhookRegistrationRecord[]> {
    const query = this.db
      .select()
      .from(pgSchema.controlHttpWebhooksPostgres)
      .$dynamic();
    const rows = await (
      appId
        ? query.where(eq(pgSchema.controlHttpWebhooksPostgres.appId, appId))
        : query
    ).orderBy(desc(pgSchema.controlHttpWebhooksPostgres.updatedAt));
    return rows.map((row) => mapWebhook(row as CanonicalControlRow));
  }

  async updateWebhook(
    webhookId: string,
    appId: string,
    patch: {
      name?: string;
      url?: string;
      secret?: string;
      enabled?: boolean;
    },
  ): Promise<WebhookRegistrationRecord | undefined> {
    const existing = await this.getWebhookById(webhookId, appId);
    if (!existing) return undefined;
    const rows = await this.db
      .update(pgSchema.controlHttpWebhooksPostgres)
      .set({
        name: patch.name ?? existing.name,
        url: patch.url ?? existing.url,
        secret: patch.secret ?? existing.secret,
        enabled: patch.enabled ?? existing.enabled,
        updatedAt: currentIso(),
      })
      .where(
        and(
          eq(pgSchema.controlHttpWebhooksPostgres.webhookId, webhookId),
          eq(pgSchema.controlHttpWebhooksPostgres.appId, appId),
        ),
      )
      .returning();
    return rows[0] ? mapWebhook(rows[0] as CanonicalControlRow) : undefined;
  }

  async deleteWebhook(webhookId: string, appId?: string): Promise<void> {
    const conditions = [
      eq(pgSchema.controlHttpWebhooksPostgres.webhookId, webhookId),
    ];
    if (appId)
      conditions.push(eq(pgSchema.controlHttpWebhooksPostgres.appId, appId));
    await this.db
      .delete(pgSchema.controlHttpWebhooksPostgres)
      .where(and(...conditions));
  }

  async enqueueWebhookDelivery(
    eventId: number,
    webhookId: string,
  ): Promise<WebhookDeliveryRecord> {
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
    if (rows[0]) return mapDelivery(rows[0] as CanonicalControlRow);
    const existing = await this.db
      .select()
      .from(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .where(
        and(
          eq(
            pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId,
            webhookId,
          ),
          eq(pgSchema.controlHttpWebhookDeliveriesPostgres.eventId, eventId),
        ),
      )
      .limit(1);
    return mapDelivery(existing[0] as CanonicalControlRow);
  }

  async listDueWebhookDeliveries(limit = 50): Promise<WebhookDeliveryRecord[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .where(
        and(
          inArray(pgSchema.controlHttpWebhookDeliveriesPostgres.status, [
            'pending',
            'retrying',
            'delivering',
          ]),
          sql`${pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt} <= ${currentIso()}`,
        ),
      )
      .orderBy(
        asc(pgSchema.controlHttpWebhookDeliveriesPostgres.nextAttemptAt),
        asc(pgSchema.controlHttpWebhookDeliveriesPostgres.createdAt),
      )
      .limit(limit);
    return rows.map((row) => mapDelivery(row as CanonicalControlRow));
  }

  async claimDueWebhookDeliveries(
    limit = 50,
  ): Promise<ClaimedWebhookDeliveryRecord[]> {
    return claimDueWebhookDeliveriesWithDrizzleLock(this.db, limit);
  }

  async markWebhookDeliveryDelivered(deliveryId: string): Promise<void> {
    await this.db
      .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .set({
        status: 'delivered',
        deliveredAt: currentIso(),
        lastAttemptAt: currentIso(),
        updatedAt: currentIso(),
        lastError: null,
      })
      .where(
        eq(
          pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
          deliveryId,
        ),
      );
  }

  async markWebhookDeliveryDelivering(input: {
    deliveryId: string;
    attemptCount: number;
    nextAttemptAt: string;
  }): Promise<void> {
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
      .where(
        eq(
          pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
          input.deliveryId,
        ),
      );
  }

  async markWebhookDeliveryRetry(input: {
    deliveryId: string;
    nextAttemptAt: string;
    lastError: string;
  }): Promise<void> {
    await this.db
      .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .set({
        status: 'retrying',
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: currentIso(),
        lastError: input.lastError,
      })
      .where(
        eq(
          pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
          input.deliveryId,
        ),
      );
  }

  async markWebhookDeliveryDead(
    deliveryId: string,
    lastError: string,
  ): Promise<void> {
    await this.db
      .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .set({
        status: 'dead_lettered',
        lastAttemptAt: currentIso(),
        updatedAt: currentIso(),
        lastError,
      })
      .where(
        eq(
          pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
          deliveryId,
        ),
      );
  }

  async replayWebhookDeadLetters(
    webhookId: string,
    appId: string,
  ): Promise<number> {
    const webhook = await this.getWebhookById(webhookId, appId);
    if (!webhook) return 0;
    const rows = await this.db
      .update(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .set({
        status: 'pending',
        nextAttemptAt: currentIso(),
        updatedAt: currentIso(),
      })
      .where(
        and(
          eq(
            pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId,
            webhookId,
          ),
          eq(
            pgSchema.controlHttpWebhookDeliveriesPostgres.status,
            'dead_lettered',
          ),
        ),
      )
      .returning({
        deliveryId: pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
      });
    return rows.length;
  }

  async purgeWebhookDeadLetters(
    webhookId: string,
    appId: string,
  ): Promise<number> {
    const webhook = await this.getWebhookById(webhookId, appId);
    if (!webhook) return 0;
    const rows = await this.db
      .delete(pgSchema.controlHttpWebhookDeliveriesPostgres)
      .where(
        and(
          eq(
            pgSchema.controlHttpWebhookDeliveriesPostgres.webhookId,
            webhookId,
          ),
          eq(
            pgSchema.controlHttpWebhookDeliveriesPostgres.status,
            'dead_lettered',
          ),
        ),
      )
      .returning({
        deliveryId: pgSchema.controlHttpWebhookDeliveriesPostgres.deliveryId,
      });
    return rows.length;
  }

  async createJobTrigger(input: {
    jobId: string;
    requestedBy?: string;
  }): Promise<JobTriggerRecord> {
    const job = await this.db
      .select({ appId: pgSchema.canonicalJobsPostgres.appId })
      .from(pgSchema.canonicalJobsPostgres)
      .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId))
      .limit(1);
    const appId = job[0]?.appId ?? 'default';
    const now = currentIso();
    const rows = await this.db
      .insert(pgSchema.canonicalJobTriggersPostgres)
      .values({
        id: randomUUID(),
        appId,
        jobId: input.jobId,
        runId: null,
        requestedBy: input.requestedBy ?? 'sdk',
        requestedAt: now,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return mapTrigger(rows[0] as CanonicalControlRow);
  }

  async bindPendingTriggerToRun(
    jobId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    return this.db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(pgSchema.canonicalJobTriggersPostgres)
        .where(
          and(
            eq(pgSchema.canonicalJobTriggersPostgres.jobId, jobId),
            eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending'),
          ),
        )
        .orderBy(
          asc(pgSchema.canonicalJobTriggersPostgres.requestedAt),
          asc(pgSchema.canonicalJobTriggersPostgres.id),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!pending) return undefined;
      const rows = await tx
        .update(pgSchema.canonicalJobTriggersPostgres)
        .set({
          runId,
          status: 'claimed',
          updatedAt: currentIso(),
        })
        .where(
          and(
            eq(pgSchema.canonicalJobTriggersPostgres.id, pending.id),
            eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending'),
          ),
        )
        .returning();
      return rows[0] ? mapTrigger(rows[0] as CanonicalControlRow) : undefined;
    });
  }

  async bindTriggerToRun(
    triggerId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const rows = await this.db
      .update(pgSchema.canonicalJobTriggersPostgres)
      .set({
        runId,
        status: 'claimed',
        updatedAt: currentIso(),
      })
      .where(
        and(
          eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId),
          eq(pgSchema.canonicalJobTriggersPostgres.status, 'pending'),
        ),
      )
      .returning();
    return rows[0] ? mapTrigger(rows[0] as CanonicalControlRow) : undefined;
  }

  async markTriggerCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void> {
    await this.db
      .update(pgSchema.canonicalJobTriggersPostgres)
      .set({ status, updatedAt: currentIso() })
      .where(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId));
  }

  async getTriggerById(
    triggerId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.canonicalJobTriggersPostgres)
      .where(eq(pgSchema.canonicalJobTriggersPostgres.id, triggerId))
      .limit(1);
    return rows[0] ? mapTrigger(rows[0] as CanonicalControlRow) : undefined;
  }
}
