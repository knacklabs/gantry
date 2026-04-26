import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { nowIso as currentIso } from '../../time/datetime.js';
import type {
  AppResponseRouteRecord,
  AppSessionRecord,
  ClaimedWebhookDeliveryRecord,
  ControlEventRecord,
  ControlResponseMode,
  JobTriggerRecord,
  WebhookDeliveryRecord,
  WebhookRegistrationRecord,
} from './control-plane-records.postgres.js';
import {
  ensureControlGraph,
  mapDelivery,
  mapEvent,
  mapRoute,
  mapSession,
  mapTrigger,
  mapWebhook,
  text,
  type CanonicalControlDb,
  type CanonicalControlRow,
} from './control-plane-canonical.postgres.js';

export class PostgresControlPlaneRepository {
  constructor(private readonly pool: Pool) {}

  async ensureAppSession(input: {
    appId: string;
    conversationId: string;
    chatJid: string;
    groupFolder: string;
    title?: string | null;
    defaultResponseMode?: ControlResponseMode;
    defaultWebhookId?: string | null;
  }): Promise<AppSessionRecord> {
    const graph = await ensureControlGraph(this.pool, {
      appId: input.appId,
      externalConversationId: input.conversationId,
      externalConversationRef: input.chatJid,
      agentFolder: input.groupFolder,
      title: input.title,
    });
    const now = currentIso();
    const existing = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_sessions
       WHERE app_id = $1 AND external_conversation_id = $2
       LIMIT 1`,
      [input.appId, input.conversationId],
    );
    const sessionId = text(existing.rows[0]?.session_id) ?? randomUUID();
    await this.pool.query(
      `INSERT INTO agent_sessions
         (id, app_id, agent_id, conversation_id, status, model_override, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', NULL, $5, $5)
       ON CONFLICT (id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         conversation_id = EXCLUDED.conversation_id,
         updated_at = EXCLUDED.updated_at`,
      [sessionId, input.appId, graph.agentId, graph.conversationId, now],
    );
    const rows = await this.pool.query<CanonicalControlRow>(
      `INSERT INTO control_http_sessions
         (session_id, app_id, external_conversation_id, conversation_id, agent_id,
          default_response_mode, default_webhook_id, external_ref_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (app_id, external_conversation_id) DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id,
         agent_id = EXCLUDED.agent_id,
         default_response_mode = EXCLUDED.default_response_mode,
         default_webhook_id = EXCLUDED.default_webhook_id,
         external_ref_json = EXCLUDED.external_ref_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        sessionId,
        input.appId,
        input.conversationId,
        graph.conversationId,
        graph.agentId,
        input.defaultResponseMode ?? 'sse',
        input.defaultWebhookId ?? null,
        JSON.stringify({
          externalConversationId: input.conversationId,
          chatJid: input.chatJid,
          groupFolder: input.groupFolder,
          title: input.title ?? null,
        }),
        now,
      ],
    );
    return mapSession(rows.rows[0]!);
  }

  async getAppSessionById(
    sessionId: string,
  ): Promise<AppSessionRecord | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_sessions WHERE session_id = $1 LIMIT 1`,
      [sessionId],
    );
    return rows.rows[0] ? mapSession(rows.rows[0]) : undefined;
  }

  async getAppSessionByChatJid(
    chatJid: string,
  ): Promise<AppSessionRecord | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_sessions
       WHERE external_ref_json::jsonb->>'chatJid' = $1
       LIMIT 1`,
      [chatJid],
    );
    return rows.rows[0] ? mapSession(rows.rows[0]) : undefined;
  }

  async addControlEvent(input: {
    eventType: string;
    payload: string;
    actor?: string;
    sessionId?: string | null;
    jobId?: string | null;
    runId?: string | null;
    triggerId?: string | null;
    correlationId?: string | null;
    responseMode?: ControlResponseMode;
    webhookId?: string | null;
  }): Promise<ControlEventRecord> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `INSERT INTO control_http_events
         (event_type, payload, actor, session_id, job_id, run_id, trigger_id, correlation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.eventType,
        input.payload,
        input.actor ?? 'runtime',
        input.sessionId ?? null,
        input.jobId ?? null,
        input.runId ?? null,
        input.triggerId ?? null,
        input.correlationId ?? null,
        currentIso(),
      ],
    );
    const event = mapEvent(rows.rows[0]!);
    const mode = input.responseMode ?? 'sse';
    const webhookId = input.webhookId ?? null;
    if ((mode === 'webhook' || mode === 'both') && webhookId) {
      await this.enqueueWebhookDelivery(event.eventId, webhookId);
    }
    return event;
  }

  async upsertAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
    responseMode: ControlResponseMode;
    webhookId?: string | null;
    correlationId?: string | null;
  }): Promise<AppResponseRouteRecord> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `INSERT INTO control_http_response_routes
         (session_id, thread_id, response_mode, webhook_id, correlation_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, thread_id) DO UPDATE SET
         response_mode = EXCLUDED.response_mode,
         webhook_id = EXCLUDED.webhook_id,
         correlation_id = EXCLUDED.correlation_id,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.sessionId,
        input.threadId?.trim() || '',
        input.responseMode,
        input.webhookId ?? null,
        input.correlationId ?? null,
        currentIso(),
      ],
    );
    return mapRoute(rows.rows[0]!);
  }

  async getAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
  }): Promise<AppResponseRouteRecord | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_response_routes
       WHERE session_id = $1 AND thread_id = $2
       LIMIT 1`,
      [input.sessionId, input.threadId?.trim() || ''],
    );
    return rows.rows[0] ? mapRoute(rows.rows[0]) : undefined;
  }

  async listSessionEvents(input: {
    sessionId: string;
    afterEventId?: number;
    limit?: number;
  }): Promise<ControlEventRecord[]> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_events
       WHERE session_id = $1 AND event_id > $2
       ORDER BY event_id ASC
       LIMIT $3`,
      [input.sessionId, input.afterEventId ?? 0, input.limit ?? 100],
    );
    return rows.rows.map(mapEvent);
  }

  async listRecentEventsForRun(runId: string): Promise<ControlEventRecord[]> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_events WHERE run_id = $1 ORDER BY event_id ASC`,
      [runId],
    );
    return rows.rows.map(mapEvent);
  }

  async registerWebhook(input: {
    webhookId?: string;
    appId: string;
    name: string;
    url: string;
    secret: string;
    enabled?: boolean;
  }): Promise<WebhookRegistrationRecord> {
    await ensureControlGraph(this.pool, {
      appId: input.appId,
      externalConversationId: 'webhooks',
      externalConversationRef: 'webhooks',
      agentFolder: 'control',
    });
    const now = currentIso();
    const rows = await this.pool.query<CanonicalControlRow>(
      `INSERT INTO control_http_webhooks
         (webhook_id, app_id, name, url, secret, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (webhook_id) DO UPDATE SET
         app_id = EXCLUDED.app_id,
         name = EXCLUDED.name,
         url = EXCLUDED.url,
         secret = EXCLUDED.secret,
         enabled = EXCLUDED.enabled,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.webhookId ?? randomUUID(),
        input.appId,
        input.name,
        input.url,
        input.secret,
        input.enabled ?? true,
        now,
      ],
    );
    return mapWebhook(rows.rows[0]!);
  }

  async getWebhookById(
    webhookId: string,
    appId?: string,
  ): Promise<(WebhookRegistrationRecord & { secret: string }) | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_webhooks
       WHERE webhook_id = $1 AND ($2::text IS NULL OR app_id = $2)
       LIMIT 1`,
      [webhookId, appId ?? null],
    );
    const row = rows.rows[0];
    return row ? { ...mapWebhook(row), secret: String(row.secret) } : undefined;
  }

  async listWebhooks(appId?: string): Promise<WebhookRegistrationRecord[]> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_webhooks
       WHERE ($1::text IS NULL OR app_id = $1)
       ORDER BY updated_at DESC`,
      [appId ?? null],
    );
    return rows.rows.map(mapWebhook);
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
    const rows = await this.pool.query<CanonicalControlRow>(
      `UPDATE control_http_webhooks SET
         name = $3,
         url = $4,
         secret = $5,
         enabled = $6,
         updated_at = $7
       WHERE webhook_id = $1 AND app_id = $2
       RETURNING *`,
      [
        webhookId,
        appId,
        patch.name ?? existing.name,
        patch.url ?? existing.url,
        patch.secret ?? existing.secret,
        patch.enabled ?? existing.enabled,
        currentIso(),
      ],
    );
    return rows.rows[0] ? mapWebhook(rows.rows[0]) : undefined;
  }

  async deleteWebhook(webhookId: string, appId?: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM control_http_webhooks
       WHERE webhook_id = $1 AND ($2::text IS NULL OR app_id = $2)`,
      [webhookId, appId ?? null],
    );
  }

  async enqueueWebhookDelivery(
    eventId: number,
    webhookId: string,
  ): Promise<WebhookDeliveryRecord> {
    const now = currentIso();
    const rows = await this.pool.query<CanonicalControlRow>(
      `INSERT INTO control_http_webhook_deliveries
         (delivery_id, webhook_id, event_id, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', 0, $4, $4, $4)
       ON CONFLICT (webhook_id, event_id) DO NOTHING
       RETURNING *`,
      [randomUUID(), webhookId, eventId, now],
    );
    if (rows.rows[0]) return mapDelivery(rows.rows[0]);
    const existing = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_webhook_deliveries
       WHERE webhook_id = $1 AND event_id = $2 LIMIT 1`,
      [webhookId, eventId],
    );
    return mapDelivery(existing.rows[0]!);
  }

  async listDueWebhookDeliveries(limit = 50): Promise<WebhookDeliveryRecord[]> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_webhook_deliveries
       WHERE status = ANY($1::text[]) AND next_attempt_at <= $2
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT $3`,
      [['pending', 'retrying', 'delivering'], currentIso(), limit],
    );
    return rows.rows.map(mapDelivery);
  }

  async claimDueWebhookDeliveries(
    limit = 50,
  ): Promise<ClaimedWebhookDeliveryRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = currentIso();
      const leaseUntil = new Date(Date.now() + 15_000).toISOString();
      const candidates = await client.query<CanonicalControlRow>(
        `SELECT * FROM control_http_webhook_deliveries
         WHERE status = ANY($1::text[]) AND next_attempt_at <= $2
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [['pending', 'retrying', 'delivering'], now, limit],
      );
      const claimed: WebhookDeliveryRecord[] = [];
      for (const candidate of candidates.rows) {
        const rows = await client.query<CanonicalControlRow>(
          `UPDATE control_http_webhook_deliveries SET
             status = 'delivering',
             attempt_count = attempt_count + 1,
             next_attempt_at = $2,
             last_attempt_at = $1,
             updated_at = $1,
             last_error = NULL
           WHERE delivery_id = $3
           RETURNING *`,
          [now, leaseUntil, candidate.delivery_id],
        );
        if (rows.rows[0]) claimed.push(mapDelivery(rows.rows[0]));
      }
      const result = await this.hydrateClaimedDeliveries(client, claimed);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async hydrateClaimedDeliveries(
    db: CanonicalControlDb,
    claimed: WebhookDeliveryRecord[],
  ): Promise<ClaimedWebhookDeliveryRecord[]> {
    if (claimed.length === 0) return [];
    const webhookIds = [...new Set(claimed.map((row) => row.webhookId))];
    const eventIds = [...new Set(claimed.map((row) => row.eventId))];
    const webhookRows = await db.query<CanonicalControlRow>(
      `SELECT * FROM control_http_webhooks WHERE webhook_id = ANY($1::text[])`,
      [webhookIds],
    );
    const eventRows = await db.query<CanonicalControlRow>(
      `SELECT * FROM control_http_events WHERE event_id = ANY($1::int[])`,
      [eventIds],
    );
    const sessionIds = [
      ...new Set(
        eventRows.rows.map((row) => text(row.session_id)).filter(Boolean),
      ),
    ];
    const sessionRows =
      sessionIds.length > 0
        ? await db.query<CanonicalControlRow>(
            `SELECT session_id, app_id FROM control_http_sessions
             WHERE session_id = ANY($1::text[])`,
            [sessionIds],
          )
        : { rows: [] };
    const webhooks = new Map(
      webhookRows.rows.map((row) => [
        String(row.webhook_id),
        { ...mapWebhook(row), secret: String(row.secret) },
      ]),
    );
    const events = new Map(
      eventRows.rows.map((row) => [Number(row.event_id), mapEvent(row)]),
    );
    const sessionApps = new Map(
      sessionRows.rows.map((row) => [
        String(row.session_id),
        String(row.app_id),
      ]),
    );
    return claimed.map((delivery) => {
      const event = events.get(delivery.eventId) ?? null;
      return {
        ...delivery,
        webhook: webhooks.get(delivery.webhookId) ?? null,
        event,
        sessionAppId: event?.sessionId
          ? (sessionApps.get(event.sessionId) ?? null)
          : null,
      };
    });
  }

  async markWebhookDeliveryDelivered(deliveryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE control_http_webhook_deliveries SET
         status = 'delivered',
         delivered_at = $2,
         last_attempt_at = $2,
         updated_at = $2,
         last_error = NULL
       WHERE delivery_id = $1`,
      [deliveryId, currentIso()],
    );
  }

  async markWebhookDeliveryDelivering(input: {
    deliveryId: string;
    attemptCount: number;
    nextAttemptAt: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE control_http_webhook_deliveries SET
         status = 'delivering',
         attempt_count = $2,
         next_attempt_at = $3,
         last_attempt_at = $4,
         updated_at = $4,
         last_error = NULL
       WHERE delivery_id = $1`,
      [input.deliveryId, input.attemptCount, input.nextAttemptAt, currentIso()],
    );
  }

  async markWebhookDeliveryRetry(input: {
    deliveryId: string;
    nextAttemptAt: string;
    lastError: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE control_http_webhook_deliveries SET
         status = 'retrying',
         next_attempt_at = $2,
         updated_at = $3,
         last_error = $4
       WHERE delivery_id = $1`,
      [input.deliveryId, input.nextAttemptAt, currentIso(), input.lastError],
    );
  }

  async markWebhookDeliveryDead(
    deliveryId: string,
    lastError: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE control_http_webhook_deliveries SET
         status = 'dead_lettered',
         last_attempt_at = $2,
         updated_at = $2,
         last_error = $3
       WHERE delivery_id = $1`,
      [deliveryId, currentIso(), lastError],
    );
  }

  async replayWebhookDeadLetters(
    webhookId: string,
    appId: string,
  ): Promise<number> {
    const webhook = await this.getWebhookById(webhookId, appId);
    if (!webhook) return 0;
    const rows = await this.pool.query<CanonicalControlRow>(
      `UPDATE control_http_webhook_deliveries SET
         status = 'pending',
         next_attempt_at = $2,
         updated_at = $2
       WHERE webhook_id = $1 AND status = 'dead_lettered'
       RETURNING delivery_id`,
      [webhookId, currentIso()],
    );
    return rows.rowCount ?? 0;
  }

  async purgeWebhookDeadLetters(
    webhookId: string,
    appId: string,
  ): Promise<number> {
    const webhook = await this.getWebhookById(webhookId, appId);
    if (!webhook) return 0;
    const rows = await this.pool.query<CanonicalControlRow>(
      `DELETE FROM control_http_webhook_deliveries
       WHERE webhook_id = $1 AND status = 'dead_lettered'
       RETURNING delivery_id`,
      [webhookId],
    );
    return rows.rowCount ?? 0;
  }

  async createJobTrigger(input: {
    jobId: string;
    requestedBy?: string;
  }): Promise<JobTriggerRecord> {
    const job = await this.pool.query<CanonicalControlRow>(
      `SELECT app_id FROM jobs WHERE id = $1 LIMIT 1`,
      [input.jobId],
    );
    const appId = text(job.rows[0]?.app_id) ?? 'default';
    const now = currentIso();
    const rows = await this.pool.query<CanonicalControlRow>(
      `INSERT INTO job_triggers
         (id, app_id, job_id, run_id, requested_by, requested_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5, 'pending', $5, $5)
       RETURNING *`,
      [randomUUID(), appId, input.jobId, input.requestedBy ?? 'sdk', now],
    );
    return mapTrigger(rows.rows[0]!);
  }

  async bindPendingTriggerToRun(
    jobId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `UPDATE job_triggers SET run_id = $2, status = 'claimed', updated_at = $3
       WHERE id = (
         SELECT id FROM job_triggers
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY requested_at ASC
         LIMIT 1
       )
       RETURNING *`,
      [jobId, runId, currentIso()],
    );
    return rows.rows[0] ? mapTrigger(rows.rows[0]) : undefined;
  }

  async bindTriggerToRun(
    triggerId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `UPDATE job_triggers SET run_id = $2, status = 'claimed', updated_at = $3
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [triggerId, runId, currentIso()],
    );
    return rows.rows[0] ? mapTrigger(rows.rows[0]) : undefined;
  }

  async markTriggerCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void> {
    await this.pool.query(
      `UPDATE job_triggers SET status = $2, updated_at = $3 WHERE id = $1`,
      [triggerId, status, currentIso()],
    );
  }

  async getTriggerById(
    triggerId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM job_triggers WHERE id = $1 LIMIT 1`,
      [triggerId],
    );
    return rows.rows[0] ? mapTrigger(rows.rows[0]) : undefined;
  }

  async getEventById(eventId: number): Promise<ControlEventRecord | undefined> {
    const rows = await this.pool.query<CanonicalControlRow>(
      `SELECT * FROM control_http_events WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    return rows.rows[0] ? mapEvent(rows.rows[0]) : undefined;
  }
}
