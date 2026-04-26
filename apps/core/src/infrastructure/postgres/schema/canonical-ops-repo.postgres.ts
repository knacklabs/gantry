import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  ChatInfo,
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  RegisteredGroup,
} from '../../../domain/repositories/domain-types.js';
import type {
  JobUpsertInput,
  OpsRepository,
} from '../../../domain/repositories/ops-repo.js';
import {
  decodeGlobalMessageCursor,
  decodeGroupMessageCursor,
  encodeGlobalMessageCursor,
  toGlobalMessageCursor,
} from '../../../shared/message-cursor.js';
import { nowIso as currentIso } from '../../time/datetime.js';
const APP_ID = 'default';
const DEFAULT_LLM_PROFILE_ID = 'llm:default';
function providerIdForJid(jid: string): string {
  const idx = jid.indexOf(':');
  return idx > 0 ? jid.slice(0, idx) : 'app';
}
function conversationIdForJid(jid: string): string {
  return `conversation:${jid}`;
}
function agentIdForFolder(folder: string): string {
  return `agent:${folder}`;
}
function configVersionIdForAgent(agentId: string): string {
  return `config:${agentId}:1`;
}
function messageIdFor(chatJid: string, id: string): string {
  return `message:${chatJid}:${id}`;
}
function threadIdFor(chatJid: string, threadId?: string | null): string | null {
  const normalized = threadId?.trim();
  return normalized ? `thread:${chatJid}:${normalized}` : null;
}
function sessionScopeKey(
  groupFolder: string,
  threadId?: string | null,
): string {
  const normalized = threadId?.trim();
  return normalized ? `${groupFolder}::thread:${normalized}` : groupFolder;
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
interface ConversationRow {
  id: string;
  external_ref_json: string | null;
  title: string | null;
  kind: string;
  updated_at: string;
  created_at: string;
  provider_id?: string;
}
interface MessageRow {
  id: string;
  conversation_id: string;
  thread_id: string | null;
  external_ref_json: string | null;
  direction: string;
  sender_user_id: string | null;
  sender_display_name: string | null;
  trust: string;
  created_at: string;
  received_at: string | null;
  payload_json: string | null;
}
interface JobRow {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  model_override: string | null;
  schedule_json: string;
  status: string;
  execution_mode: string;
  target_json: string;
  silent: boolean;
  timeout_ms: number;
  max_retries: number;
  retry_backoff_ms: number;
  next_run_at: string | null;
  last_run_at: string | null;
  lease_run_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}
interface RunRow {
  id: string;
  job_id: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  result_summary: string | null;
  error_summary: string | null;
}
export class PostgresCanonicalOpsRepository implements OpsRepository {
  constructor(private readonly pool: Pool) {}
  async close(): Promise<void> {
    await this.pool.end();
  }
  private async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
    client: Pool | PoolClient = this.pool,
  ): Promise<T[]> {
    const result = await client.query<T>(text, values);
    return result.rows;
  }
  private async ensureApp(
    client: Pool | PoolClient = this.pool,
  ): Promise<void> {
    await this.query(
      `INSERT INTO apps(id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [APP_ID, 'default', 'Default App'],
      client,
    );
    await this.query(
      `INSERT INTO llm_profiles(id, app_id, purpose, model_alias) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [DEFAULT_LLM_PROFILE_ID, APP_ID, 'default', 'default'],
      client,
    );
  }
  private async ensureAgent(
    folder: string,
    name: string = folder,
    client: Pool | PoolClient = this.pool,
  ): Promise<string> {
    await this.ensureApp(client);
    const agentId = agentIdForFolder(folder);
    const configVersionId = configVersionIdForAgent(agentId);
    await this.query(
      `INSERT INTO agents(id, app_id, name, status, current_config_version_id) VALUES ($1, $2, $3, 'active', $4) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, current_config_version_id = EXCLUDED.current_config_version_id, updated_at = now()`,
      [agentId, APP_ID, name, configVersionId],
      client,
    );
    await this.query(
      `INSERT INTO agent_config_versions( id, app_id, agent_id, version, prompt_profile_ref, llm_profile_id ) VALUES ($1, $2, $3, 1, 'default', $4) ON CONFLICT (id) DO NOTHING`,
      [configVersionId, APP_ID, agentId, DEFAULT_LLM_PROFILE_ID],
      client,
    );
    return agentId;
  }
  private async ensureConversation(
    jid: string,
    input: {
      name?: string | null;
      channel?: string | null;
      isGroup?: boolean | null;
      timestamp?: string | null;
    } = {},
    client: Pool | PoolClient = this.pool,
  ): Promise<string> {
    await this.ensureApp(client);
    const providerId = input.channel || providerIdForJid(jid);
    const installationId = `channel-installation:${APP_ID}:${providerId}`;
    const conversationId = conversationIdForJid(jid);
    const title = input.name || jid;
    const now = input.timestamp || currentIso();
    await this.query(
      `INSERT INTO channel_providers(id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [providerId, providerId],
      client,
    );
    await this.query(
      `INSERT INTO channel_installations(id, app_id, provider_id, label) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [installationId, APP_ID, providerId, providerId],
      client,
    );
    await this.query(
      `INSERT INTO conversations( id, app_id, channel_installation_id, external_ref_json, kind, title, created_at, updated_at ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, external_ref_json = EXCLUDED.external_ref_json, updated_at = GREATEST(conversations.updated_at, EXCLUDED.updated_at)`,
      [
        conversationId,
        APP_ID,
        installationId,
        json({ jid, providerId, isGroup: Boolean(input.isGroup) }),
        input.isGroup ? 'group' : 'direct',
        title,
        now,
      ],
      client,
    );
    return conversationId;
  }
  private async ensureThread(
    chatJid: string,
    threadId?: string | null,
    client: Pool | PoolClient = this.pool,
  ): Promise<string | null> {
    const canonicalThreadId = threadIdFor(chatJid, threadId);
    if (!canonicalThreadId) return null;
    const conversationId = await this.ensureConversation(chatJid, {}, client);
    await this.query(
      `INSERT INTO conversation_threads( id, app_id, conversation_id, external_ref_json, created_at, updated_at ) VALUES ($1, $2, $3, $4, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [
        canonicalThreadId,
        APP_ID,
        conversationId,
        json({ jid: chatJid, threadId }),
      ],
      client,
    );
    return canonicalThreadId;
  }
  async storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    await this.ensureConversation(chatJid, {
      name,
      channel,
      isGroup,
      timestamp,
    });
  }
  async getAllChats(): Promise<ChatInfo[]> {
    const rows = await this.query<ConversationRow>(
      `SELECT c.*, ci.provider_id FROM conversations c JOIN channel_installations ci ON ci.id = c.channel_installation_id ORDER BY c.updated_at DESC`,
    );
    return rows.map((row) => {
      const ref = parseJson<{ jid?: string }>(row.external_ref_json, {});
      return {
        jid: ref.jid || row.id,
        name: row.title || ref.jid || row.id,
        last_message_time: row.updated_at,
        channel: row.provider_id || '',
        is_group: row.kind === 'group' ? 1 : 0,
      };
    });
  }
  async storeMessage(msg: NewMessage): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const conversationId = await this.ensureConversation(
        msg.chat_jid,
        { timestamp: msg.timestamp },
        client,
      );
      const canonicalThreadId = await this.ensureThread(
        msg.chat_jid,
        msg.thread_id,
        client,
      );
      const canonicalMessageId = messageIdFor(msg.chat_jid, msg.id);
      const direction =
        msg.is_from_me || msg.is_bot_message ? 'outbound' : 'inbound';
      await this.query(
        `INSERT INTO canonical_messages( id, app_id, conversation_id, thread_id, external_ref_json, direction, sender_user_id, sender_display_name, trust, created_at, received_at ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) ON CONFLICT (id) DO UPDATE SET external_ref_json = EXCLUDED.external_ref_json, direction = EXCLUDED.direction, sender_user_id = EXCLUDED.sender_user_id, sender_display_name = EXCLUDED.sender_display_name, trust = EXCLUDED.trust`,
        [
          canonicalMessageId,
          APP_ID,
          conversationId,
          canonicalThreadId,
          json(msg),
          direction,
          msg.sender,
          msg.sender_name,
          msg.is_bot_message ? 'system' : 'trusted',
          msg.timestamp,
        ],
        client,
      );
      await this.query(
        `DELETE FROM message_parts WHERE message_id = $1`,
        [canonicalMessageId],
        client,
      );
      await this.query(
        `INSERT INTO message_parts(message_id, ordinal, kind, payload_json) VALUES ($1, 0, 'text', $2)`,
        [canonicalMessageId, json({ kind: 'text', text: msg.content })],
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  private mapMessage(row: MessageRow): NewMessage {
    const ref = parseJson<Partial<NewMessage>>(row.external_ref_json, {});
    const payload = parseJson<{ text?: string }>(row.payload_json, {});
    return {
      id: ref.id || row.id,
      chat_jid: ref.chat_jid || ref.chat_jid || row.conversation_id,
      sender: row.sender_user_id || ref.sender || '',
      sender_name: row.sender_display_name || ref.sender_name || '',
      content: ref.content || payload.text || '',
      timestamp: row.created_at,
      is_from_me: ref.is_from_me ?? row.direction === 'outbound',
      is_bot_message: ref.is_bot_message ?? row.trust === 'system',
      thread_id: ref.thread_id,
      reply_to_message_id: ref.reply_to_message_id,
      reply_to_message_content: ref.reply_to_message_content,
      reply_to_sender_name: ref.reply_to_sender_name,
    };
  }
  private async messageRowsForJids(jids: string[]): Promise<MessageRow[]> {
    if (jids.length === 0) return [];
    return this.query<MessageRow>(
      `SELECT m.*, p.payload_json FROM canonical_messages m JOIN message_parts p ON p.message_id = m.id AND p.ordinal = 0 WHERE m.conversation_id = ANY($1) AND m.direction = 'inbound' AND p.kind = 'text' ORDER BY m.created_at ASC, m.conversation_id ASC, m.id ASC`,
      [jids.map((jid) => conversationIdForJid(jid))],
    );
  }
  async getNewMessages(
    jids: string[],
    lastCursor: string,
    limit: number = 200,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    const cursor = decodeGlobalMessageCursor(lastCursor);
    const rows = await this.messageRowsForJids(jids);
    const messages = rows
      .map((row) => this.mapMessage(row))
      .filter(
        (msg) =>
          msg.content &&
          (msg.timestamp > cursor.timestamp ||
            (msg.timestamp === cursor.timestamp &&
              (msg.chat_jid > cursor.chatJid ||
                (msg.chat_jid === cursor.chatJid && msg.id > cursor.id)))),
      )
      .slice(0, limit);
    const latest = messages[messages.length - 1];
    return {
      messages,
      newTimestamp: latest
        ? encodeGlobalMessageCursor(toGlobalMessageCursor(latest))
        : lastCursor,
    };
  }
  async getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit: number = 200,
    options: { threadId?: string | null } = {},
  ): Promise<NewMessage[]> {
    const cursor = decodeGroupMessageCursor(sinceCursor);
    const rows = await this.messageRowsForJids([chatJid]);
    const hasThreadFilter = Object.prototype.hasOwnProperty.call(
      options,
      'threadId',
    );
    const threadId = options.threadId?.trim() || undefined;
    return rows
      .map((row) => this.mapMessage(row))
      .filter(
        (msg) =>
          msg.content &&
          (msg.timestamp > cursor.timestamp ||
            (msg.timestamp === cursor.timestamp && msg.id > cursor.id)) &&
          (!hasThreadFilter || (msg.thread_id || undefined) === threadId),
      )
      .slice(0, limit);
  }
  async getMessageThreadIds(chatJid: string): Promise<Array<string | null>> {
    const rows = await this.messageRowsForJids([chatJid]);
    const seen = new Set<string>();
    const result: Array<string | null> = [];
    for (const row of rows) {
      const threadId = this.mapMessage(row).thread_id || null;
      const key = threadId || '';
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(threadId);
    }
    return result;
  }
  async getLastBotMessageCursor(
    chatJid: string,
  ): Promise<{ timestamp: string; id: string } | undefined> {
    const rows = await this.query<MessageRow>(
      `SELECT m.*, p.payload_json FROM canonical_messages m JOIN message_parts p ON p.message_id = m.id AND p.ordinal = 0 WHERE m.conversation_id = $1 AND m.trust = 'system' ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
      [conversationIdForJid(chatJid)],
    );
    const msg = rows[0] ? this.mapMessage(rows[0]) : undefined;
    return msg ? { timestamp: msg.timestamp, id: msg.id } : undefined;
  }
  async getLastBotMessageTimestamp(
    chatJid: string,
  ): Promise<string | undefined> {
    return (await this.getLastBotMessageCursor(chatJid))?.timestamp;
  }
  private async rowToJob(row: JobRow): Promise<Job> {
    const schedule = parseJson<{ type?: string; value?: string }>(
      row.schedule_json,
      {},
    );
    const target = parseJson<Record<string, unknown>>(row.target_json, {});
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      model: row.model_override,
      script: (target.script as string | null | undefined) ?? null,
      schedule_type: (schedule.type as Job['schedule_type']) || 'manual',
      schedule_value: schedule.value || '',
      status: row.status as Job['status'],
      linked_sessions: (target.linkedSessions as string[] | undefined) ?? [],
      session_id: (target.sessionId as string | null | undefined) ?? null,
      thread_id: (target.threadId as string | null | undefined) ?? null,
      group_scope:
        (target.groupScope as string | undefined) ||
        row.agent_id.replace(/^agent:/, ''),
      created_by: (target.createdBy as Job['created_by']) || 'agent',
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_run: row.next_run_at,
      last_run: row.last_run_at,
      silent: row.silent,
      cleanup_after_ms: Number(target.cleanupAfterMs ?? 86400000),
      timeout_ms: row.timeout_ms,
      max_retries: row.max_retries,
      retry_backoff_ms: row.retry_backoff_ms,
      max_consecutive_failures: Number(target.maxConsecutiveFailures ?? 5),
      consecutive_failures: Number(target.consecutiveFailures ?? 0),
      execution_mode: row.execution_mode as Job['execution_mode'],
      lease_run_id: row.lease_run_id,
      lease_expires_at: row.lease_expires_at,
      pause_reason: (target.pauseReason as string | null | undefined) ?? null,
    };
  }
  private async ensureJobRunGraph(
    jobId: string,
    client: Pool | PoolClient = this.pool,
  ): Promise<{ agentId: string; configVersionId: string }> {
    const job = await this.query<JobRow>(
      `SELECT * FROM jobs WHERE id = $1 LIMIT 1`,
      [jobId],
      client,
    );
    const row = job[0];
    const folder = row
      ? ((parseJson<Record<string, unknown>>(row.target_json, {}).groupScope as
          | string
          | undefined) ?? row.agent_id.replace(/^agent:/, ''))
      : 'system';
    const agentId = await this.ensureAgent(folder, folder, client);
    return { agentId, configVersionId: configVersionIdForAgent(agentId) };
  }
  async upsertJob(job: JobUpsertInput): Promise<{ created: boolean }> {
    const now = currentIso();
    const agentId = await this.ensureAgent(job.group_scope, job.group_scope);
    const existing = await this.getJobById(job.id);
    const status =
      existing?.status === 'running' || existing?.status === 'dead_lettered'
        ? existing.status
        : job.status || 'active';
    await this.query(
      `INSERT INTO jobs( id, app_id, agent_id, name, prompt, model_override, schedule_json, status, execution_mode, target_json, silent, timeout_ms, max_retries, retry_backoff_ms, next_run_at, last_run_at, lease_run_id, lease_expires_at, created_at, updated_at ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, prompt = EXCLUDED.prompt, model_override = EXCLUDED.model_override, schedule_json = EXCLUDED.schedule_json, status = EXCLUDED.status, execution_mode = EXCLUDED.execution_mode, target_json = EXCLUDED.target_json, silent = EXCLUDED.silent, timeout_ms = EXCLUDED.timeout_ms, max_retries = EXCLUDED.max_retries, retry_backoff_ms = EXCLUDED.retry_backoff_ms, next_run_at = EXCLUDED.next_run_at, last_run_at = EXCLUDED.last_run_at, updated_at = EXCLUDED.updated_at`,
      [
        job.id,
        APP_ID,
        agentId,
        job.name,
        job.prompt,
        job.model || null,
        json({ type: job.schedule_type, value: job.schedule_value }),
        status,
        job.execution_mode || 'parallel',
        json({
          linkedSessions: job.linked_sessions,
          sessionId: job.session_id ?? null,
          threadId: job.thread_id ?? null,
          groupScope: job.group_scope,
          createdBy: job.created_by || 'agent',
          script: job.script ?? null,
          cleanupAfterMs: job.cleanup_after_ms ?? 86400000,
          maxConsecutiveFailures: job.max_consecutive_failures ?? 5,
          consecutiveFailures: job.consecutive_failures ?? 0,
          pauseReason: job.pause_reason ?? null,
        }),
        Boolean(job.silent),
        job.timeout_ms ?? 300000,
        job.max_retries ?? 3,
        job.retry_backoff_ms ?? 5000,
        job.next_run ?? null,
        job.last_run ?? null,
        job.lease_run_id ?? null,
        job.lease_expires_at ?? null,
        job.created_at || now,
        job.updated_at || now,
      ],
    );
    return { created: !existing };
  }
  async getJobById(id: string): Promise<Job | undefined> {
    const rows = await this.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? this.rowToJob(rows[0]) : undefined;
  }
  async getAllJobs(): Promise<Job[]> {
    const rows = await this.query<JobRow>(
      `SELECT * FROM jobs ORDER BY updated_at DESC, created_at DESC`,
    );
    return Promise.all(rows.map((row) => this.rowToJob(row)));
  }
  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    const current = await this.getJobById(id);
    if (!current) return;
    const next = { ...current, ...updates };
    const agentId = await this.ensureAgent(next.group_scope, next.group_scope);
    const updatedAt = updates.updated_at ?? currentIso();

    await this.query(
      `UPDATE jobs SET agent_id = $2, name = $3, prompt = $4, model_override = $5, schedule_json = $6, status = $7, execution_mode = $8, target_json = $9, silent = $10, timeout_ms = $11, max_retries = $12, retry_backoff_ms = $13, next_run_at = $14, last_run_at = $15, lease_run_id = $16, lease_expires_at = $17, updated_at = $18 WHERE id = $1`,
      [
        id,
        agentId,
        next.name,
        next.prompt,
        next.model || null,
        json({ type: next.schedule_type, value: next.schedule_value }),
        next.status,
        next.execution_mode || 'parallel',
        json({
          linkedSessions: next.linked_sessions,
          sessionId: next.session_id ?? null,
          threadId: next.thread_id ?? null,
          groupScope: next.group_scope,
          createdBy: next.created_by || 'agent',
          script: next.script ?? null,
          cleanupAfterMs: next.cleanup_after_ms ?? 86400000,
          maxConsecutiveFailures: next.max_consecutive_failures ?? 5,
          consecutiveFailures: next.consecutive_failures ?? 0,
          pauseReason: next.pause_reason ?? null,
        }),
        Boolean(next.silent),
        next.timeout_ms ?? 300000,
        next.max_retries ?? 3,
        next.retry_backoff_ms ?? 5000,
        next.next_run ?? null,
        next.last_run ?? null,
        next.lease_run_id ?? null,
        next.lease_expires_at ?? null,
        updatedAt,
      ],
    );
  }
  async deleteJob(id: string): Promise<void> {
    await this.query(`DELETE FROM jobs WHERE id = $1`, [id]);
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
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await this.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`,
        [input.jobId],
        client,
      );
      const job = rows[0] ? await this.rowToJob(rows[0]) : undefined;
      if (
        !job ||
        job.status !== 'active' ||
        (input.requireNextRun !== false && job.next_run !== input.scheduledFor)
      ) {
        await client.query('ROLLBACK');
        return false;
      }
      const inserted = await this.insertRun(
        {
          run_id: input.runId,
          job_id: input.jobId,
          scheduled_for: input.scheduledFor,
          started_at: input.startedAt,
          ended_at: null,
          status: 'running',
          result_summary: null,
          error_summary: null,
          retry_count: input.retryCount,
          notified_at: null,
        },
        client,
      );
      if (!inserted) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.query(
        `UPDATE jobs SET status = 'running', lease_run_id = $2, lease_expires_at = $3, updated_at = $4 WHERE id = $1`,
        [input.jobId, input.runId, input.leaseExpiresAt, input.startedAt],
        client,
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  async releaseStaleJobLeases(nowIso: string = currentIso()): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE jobs SET status = 'active', lease_run_id = NULL, lease_expires_at = NULL, updated_at = $1 WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1 RETURNING id`,
      [nowIso],
    );
    return rows.length;
  }
  private async insertRun(
    run: JobRun,
    client: Pool | PoolClient = this.pool,
  ): Promise<boolean> {
    const graph = await this.ensureJobRunGraph(run.job_id, client);
    const rows = await this.query<{ id: string }>(
      `INSERT INTO agent_runs( id, app_id, agent_id, config_version_id, job_id, llm_profile_id, cause, status, created_at, started_at, ended_at, result_summary, error_summary ) VALUES ($1,$2,$3,$4,$5,$6,'job',$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        run.run_id,
        APP_ID,
        graph.agentId,
        graph.configVersionId,
        run.job_id,
        DEFAULT_LLM_PROFILE_ID,
        run.status,
        run.scheduled_for || run.started_at,
        run.started_at,
        run.ended_at,
        run.result_summary,
        run.error_summary,
      ],
      client,
    );
    return rows.length > 0;
  }
  async createJobRun(run: JobRun): Promise<boolean> {
    return this.insertRun(run);
  }
  private mapRun(row: RunRow): JobRun {
    return {
      run_id: row.id,
      job_id: row.job_id || '',
      scheduled_for: row.created_at,
      started_at: row.started_at || row.created_at,
      ended_at: row.ended_at,
      status: row.status as JobRun['status'],
      result_summary: row.result_summary,
      error_summary: row.error_summary,
      retry_count: 0,
      notified_at: null,
    };
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
    await this.query(
      `UPDATE agent_runs SET status = $2, ended_at = $3, result_summary = $4, error_summary = $5 WHERE id = $1`,
      [runId, status, currentIso(), resultSummary, errorSummary],
    );
  }
  async markJobRunNotified(_runId: string): Promise<void> {}
  async getJobRunById(runId: string): Promise<JobRun | undefined> {
    const rows = await this.query<RunRow>(
      `SELECT * FROM agent_runs WHERE id = $1`,
      [runId],
    );
    return rows[0] ? this.mapRun(rows[0]) : undefined;
  }
  async listJobRuns(jobId?: string, limit = 50): Promise<JobRun[]> {
    const rows = jobId
      ? await this.query<RunRow>(
          `SELECT * FROM agent_runs WHERE job_id = $1 ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT $2`,
          [jobId, limit],
        )
      : await this.query<RunRow>(
          `SELECT * FROM agent_runs ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT $1`,
          [limit],
        );
    return rows.map((row) => this.mapRun(row));
  }
  async listDeadLetterRuns(limit = 50): Promise<JobRun[]> {
    const rows = await this.query<RunRow>(
      `SELECT * FROM agent_runs WHERE status = 'dead_lettered' ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => this.mapRun(row));
  }
  async addJobEvent(event: Omit<JobEvent, 'id'>): Promise<void> {
    const runId = event.run_id || `run:${event.job_id}`;
    await this.insertRun({
      run_id: runId,
      job_id: event.job_id,
      scheduled_for: event.created_at,
      started_at: event.created_at,
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    await this.query(
      `INSERT INTO agent_run_events(id, app_id, run_id, type, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        APP_ID,
        runId,
        event.event_type,
        json(event),
        event.created_at,
      ],
    );
  }
  async listRecentJobEvents(
    limit = 200,
    filters?: { job_id?: string; run_id?: string; event_type?: string },
  ): Promise<JobEvent[]> {
    const rows = await this.query<{
      id: string;
      run_id: string;
      type: string;
      payload_json: string;
      created_at: string;
    }>(
      `SELECT * FROM agent_run_events WHERE ($2::text IS NULL OR run_id = $2) AND ($3::text IS NULL OR type = $3) ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit, filters?.run_id ?? null, filters?.event_type ?? null],
    );
    return rows
      .map((row, index) => {
        const payload = parseJson<Partial<JobEvent>>(row.payload_json, {});
        return {
          id: index + 1,
          job_id: payload.job_id || filters?.job_id || '',
          run_id: row.run_id,
          event_type: row.type,
          payload: payload.payload ?? row.payload_json,
          created_at: row.created_at,
        };
      })
      .filter((event) => !filters?.job_id || event.job_id === filters.job_id);
  }
  async getRouterState(key: string): Promise<string | undefined> {
    const rows = await this.query<{ value: string }>(
      `SELECT value FROM router_state WHERE key = $1 LIMIT 1`,
      [key],
    );
    return rows[0]?.value;
  }
  async setRouterState(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO router_state(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  async getSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<string | undefined> {
    const scopeKey = sessionScopeKey(groupFolder, threadId);
    const rows = await this.query<{ id: string }>(
      `SELECT ps.id FROM provider_sessions ps JOIN agent_sessions s ON s.id = ps.agent_session_id WHERE s.user_id = $1 ORDER BY ps.updated_at DESC LIMIT 1`,
      [scopeKey],
    );
    return rows[0]?.id;
  }
  async setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
  ): Promise<void> {
    const agentId = await this.ensureAgent(groupFolder, groupFolder);
    const scopeKey = sessionScopeKey(groupFolder, threadId);
    const agentSessionId = `agent-session:${scopeKey}`;
    await this.query(
      `INSERT INTO agent_sessions(id, app_id, agent_id, user_id, status) VALUES ($1, $2, $3, $4, 'active') ON CONFLICT (id) DO UPDATE SET status = 'active', updated_at = now()`,
      [agentSessionId, APP_ID, agentId, scopeKey],
    );
    await this.query(
      `INSERT INTO provider_sessions( id, app_id, agent_session_id, provider_ref_json, status ) VALUES ($1, $2, $3, $4, 'active') ON CONFLICT (id) DO UPDATE SET agent_session_id = EXCLUDED.agent_session_id, updated_at = now()`,
      [sessionId, APP_ID, agentSessionId, json({ kind: 'runtime_session' })],
    );
  }
  async deleteSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<void> {
    await this.query(`DELETE FROM agent_sessions WHERE user_id = $1`, [
      sessionScopeKey(groupFolder, threadId),
    ]);
  }
  async deleteSessionsByGroupFolder(groupFolder: string): Promise<void> {
    await this.query(
      `DELETE FROM agent_sessions WHERE user_id = $1 OR user_id LIKE $2`,
      [groupFolder, `${groupFolder}::thread:%`],
    );
  }
  async getAllSessions(): Promise<Record<string, string>> {
    const rows = await this.query<{ user_id: string; id: string }>(
      `SELECT s.user_id, ps.id FROM provider_sessions ps JOIN agent_sessions s ON s.id = ps.agent_session_id WHERE s.user_id IS NOT NULL`,
    );
    return Object.fromEntries(rows.map((row) => [row.user_id, row.id]));
  }
  async getRegisteredGroup(jid: string): Promise<RegisteredGroup | undefined> {
    return (await this.getAllRegisteredGroups())[jid];
  }
  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const conversationId = await this.ensureConversation(
        jid,
        { name: group.name, isGroup: group.requiresTrigger !== false },
        client,
      );
      const agentId = await this.ensureAgent(group.folder, group.name, client);
      await this.query(
        `INSERT INTO agent_channel_bindings( id, app_id, agent_id, channel_installation_id, conversation_id, display_name, trigger_pattern, requires_trigger, is_admin_binding, memory_subject_json, permission_policy_ids_json, created_at, updated_at ) SELECT $1, $2, $3, c.channel_installation_id, $4, $5, $6, $7, $8, $9, '[]', $10, $10 FROM conversations c WHERE c.id = $4 ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, trigger_pattern = EXCLUDED.trigger_pattern, requires_trigger = EXCLUDED.requires_trigger, is_admin_binding = EXCLUDED.is_admin_binding, memory_subject_json = EXCLUDED.memory_subject_json, updated_at = EXCLUDED.updated_at`,
        [
          `binding:${jid}`,
          APP_ID,
          agentId,
          conversationId,
          group.name,
          group.trigger,
          group.requiresTrigger ?? true,
          Boolean(group.isMain),
          json({ jid, group }),
          group.added_at || currentIso(),
        ],
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  async deleteRegisteredGroup(jid: string): Promise<void> {
    await this.query(`DELETE FROM agent_channel_bindings WHERE id = $1`, [
      `binding:${jid}`,
    ]);
  }
  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    const rows = await this.query<{
      memory_subject_json: string;
      display_name: string;
      trigger_pattern: string | null;
      requires_trigger: boolean;
      is_admin_binding: boolean;
      created_at: string;
    }>(
      `SELECT memory_subject_json, display_name, trigger_pattern, requires_trigger, is_admin_binding, created_at FROM agent_channel_bindings ORDER BY created_at ASC`,
    );
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      const subject = parseJson<{ jid?: string; group?: RegisteredGroup }>(
        row.memory_subject_json,
        {},
      );
      if (!subject.jid) continue;
      result[subject.jid] = {
        name: subject.group?.name || row.display_name,
        folder: subject.group?.folder || subject.jid,
        trigger: subject.group?.trigger || row.trigger_pattern || '',
        added_at: subject.group?.added_at || row.created_at,
        agentConfig: subject.group?.agentConfig,
        requiresTrigger: row.requires_trigger,
        isMain: row.is_admin_binding || undefined,
      };
    }
    return result;
  }
}
