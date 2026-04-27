import type { Pool, PoolClient } from 'pg';

import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import type {
  AppResponseRouteRecord,
  AppSessionRecord,
  ControlEventRecord,
  ControlResponseMode,
  JobTriggerRecord,
  WebhookDeliveryRecord,
  WebhookRegistrationRecord,
} from './control-plane-records.postgres.js';

export type CanonicalControlDb = Pool | PoolClient;
export type CanonicalControlRow = Record<string, unknown>;

const DEFAULT_LLM_PROFILE_ID = 'llm:default';
const CONTROL_PROVIDER_ID = 'control-http';

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseJsonObject(value: unknown): CanonicalControlRow {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as CanonicalControlRow)
      : {};
  } catch {
    return {};
  }
}

function agentIdForFolder(folder: string): string {
  return `agent:${folder || 'default'}`;
}

function folderFromAgentId(agentId: string): string {
  return agentId.startsWith('agent:')
    ? agentId.slice('agent:'.length)
    : agentId;
}

function controlInstallationId(appId: string): string {
  return `control:${appId}`;
}

function controlConversationId(appId: string, externalConversationId: string) {
  return `control:${appId}:conversation:${externalConversationId}`;
}

export function mapSession(row: CanonicalControlRow): AppSessionRecord {
  const external = parseJsonObject(row.external_ref_json);
  const agentId = String(row.agent_id);
  return {
    sessionId: String(row.session_id),
    appId: String(row.app_id),
    conversationId: String(row.external_conversation_id),
    chatJid:
      text(external.chatJid) ??
      text(external.externalConversationRef) ??
      String(row.external_conversation_id),
    groupFolder: text(external.groupFolder) ?? folderFromAgentId(agentId),
    title: text(external.title),
    defaultResponseMode:
      (row.default_response_mode as ControlResponseMode | null) ?? 'sse',
    defaultWebhookId: text(row.default_webhook_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapRoute(row: CanonicalControlRow): AppResponseRouteRecord {
  return {
    sessionId: String(row.session_id),
    threadId: String(row.thread_id ?? ''),
    responseMode: row.response_mode as ControlResponseMode,
    webhookId: text(row.webhook_id),
    correlationId: text(row.correlation_id),
    updatedAt: String(row.updated_at),
  };
}

export function mapEvent(row: CanonicalControlRow): ControlEventRecord {
  return {
    eventId: Number(row.event_id),
    eventType: String(row.event_type),
    sessionId: text(row.session_id),
    jobId: text(row.job_id),
    runId: text(row.run_id),
    triggerId: text(row.trigger_id),
    correlationId: text(row.correlation_id),
    actor: String(row.actor),
    payload: String(row.payload),
    createdAt: String(row.created_at),
  };
}

export function mapWebhook(
  row: CanonicalControlRow,
): WebhookRegistrationRecord {
  return {
    webhookId: String(row.webhook_id),
    appId: String(row.app_id),
    name: String(row.name),
    url: String(row.url),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapDelivery(row: CanonicalControlRow): WebhookDeliveryRecord {
  return {
    deliveryId: String(row.delivery_id),
    webhookId: String(row.webhook_id),
    eventId: Number(row.event_id),
    status: String(row.status),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: String(row.next_attempt_at),
    lastAttemptAt: text(row.last_attempt_at),
    deliveredAt: text(row.delivered_at),
    lastError: text(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapTrigger(row: CanonicalControlRow): JobTriggerRecord {
  return {
    triggerId: String(row.id),
    jobId: String(row.job_id),
    runId: text(row.run_id),
    requestedAt: String(row.requested_at),
    requestedBy: String(row.requested_by),
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function ensureControlGraph(
  db: CanonicalControlDb,
  input: {
    appId: string;
    externalConversationId: string;
    externalConversationRef: string;
    agentFolder: string;
    title?: string | null;
  },
) {
  const now = currentIso();
  const appId = input.appId;
  const agentId = agentIdForFolder(input.agentFolder);
  const configId = `config:${agentId}:1`;
  const installationId = controlInstallationId(appId);
  const conversationId = controlConversationId(
    appId,
    input.externalConversationId,
  );
  await db.query(
    `INSERT INTO apps (id, slug, name, status, created_at, updated_at)
     VALUES ($1, $1, $1, 'active', $2, $2)
     ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [appId, now],
  );
  await db.query(
    `INSERT INTO llm_profiles
       (id, app_id, purpose, model_alias, thinking_json, budget_json, created_at, updated_at)
     VALUES ($1, $2, 'default', 'runtime-default', '{}', '{}', $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_LLM_PROFILE_ID, appId, now],
  );
  await db.query(
    `INSERT INTO agents (id, app_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
    [agentId, appId, input.agentFolder || 'default', now],
  );
  await db.query(
    `INSERT INTO agent_config_versions
       (id, app_id, agent_id, version, prompt_profile_ref, llm_profile_id, created_at)
     VALUES ($1, $2, $3, 1, 'runtime-default', $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [configId, appId, agentId, DEFAULT_LLM_PROFILE_ID, now],
  );
  await db.query(
    `UPDATE agents
     SET current_config_version_id = COALESCE(current_config_version_id, $2),
         updated_at = $3
     WHERE id = $1`,
    [agentId, configId, now],
  );
  await db.query(
    `INSERT INTO channel_providers (id, display_name, capability_flags_json, created_at)
     VALUES ($1, 'Control HTTP', '[]', $2)
     ON CONFLICT (id) DO NOTHING`,
    [CONTROL_PROVIDER_ID, now],
  );
  await db.query(
    `INSERT INTO channel_installations
       (id, app_id, provider_id, external_ref_json, label, status, runtime_secret_refs_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Control HTTP', 'active', '[]', $5, $5)
     ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [
      installationId,
      appId,
      CONTROL_PROVIDER_ID,
      JSON.stringify({ adapter: 'control-http', appId }),
      now,
    ],
  );
  await db.query(
    `INSERT INTO channel_conversations
       (id, app_id, channel_installation_id, external_ref_json, kind, title, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'app', $5, 'active', $6, $6)
     ON CONFLICT (id) DO UPDATE SET
       external_ref_json = EXCLUDED.external_ref_json,
       title = EXCLUDED.title,
       updated_at = EXCLUDED.updated_at`,
    [
      conversationId,
      appId,
      installationId,
      JSON.stringify({
        externalConversationId: input.externalConversationId,
        externalConversationRef: input.externalConversationRef,
      }),
      input.title ?? null,
      now,
    ],
  );
  return { agentId, conversationId };
}
