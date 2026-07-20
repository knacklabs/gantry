import type {
  AppResponseRouteRecord,
  AppSessionRecord,
  ControlEventRecord,
  ControlResponseMode,
  JobTriggerRecord,
  WebhookDeliveryRecord,
  WebhookRegistrationRecord,
} from './control-plane-records.postgres.js';

export type CanonicalControlRow = Record<string, unknown>;

function column(
  row: CanonicalControlRow,
  snakeName: string,
  camelName: string,
): unknown {
  return row[snakeName] ?? row[camelName];
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  return values.length > 0 ? values : null;
}

function parseJsonObject(value: unknown): CanonicalControlRow {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as CanonicalControlRow;
  }
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

function folderFromAgentId(agentId: string): string {
  return agentId.startsWith('agent:')
    ? agentId.slice('agent:'.length)
    : agentId;
}

export function mapSession(row: CanonicalControlRow): AppSessionRecord {
  const external = parseJsonObject(
    column(row, 'external_ref_json', 'externalRefJson'),
  );
  const agentId = String(column(row, 'agent_id', 'agentId'));
  const workspaceKey =
    text(external.workspaceFolder) ?? folderFromAgentId(agentId);
  const conversationId = String(
    column(row, 'external_conversation_id', 'externalConversationId'),
  );
  return {
    sessionId: String(column(row, 'session_id', 'sessionId')),
    appId: String(column(row, 'app_id', 'appId')),
    conversationId,
    chatJid:
      text(external.chatJid) ??
      text(external.externalConversationRef) ??
      conversationId,
    workspaceFolder: workspaceKey,
    workspaceKey,
    title: text(external.title),
    defaultResponseMode:
      (column(
        row,
        'default_response_mode',
        'defaultResponseMode',
      ) as ControlResponseMode | null) ?? 'sse',
    defaultWebhookId: text(
      column(row, 'default_webhook_id', 'defaultWebhookId'),
    ),
    appUser:
      typeof external.appUser === 'object' &&
      external.appUser !== null &&
      !Array.isArray(external.appUser) &&
      typeof (external.appUser as Record<string, unknown>).authorityId ===
        'string' &&
      typeof (external.appUser as Record<string, unknown>).subject === 'string'
        ? {
            authorityId: (external.appUser as Record<string, string>)
              .authorityId,
            subject: (external.appUser as Record<string, string>).subject,
          }
        : null,
    createdAt: String(column(row, 'created_at', 'createdAt')),
    updatedAt: String(column(row, 'updated_at', 'updatedAt')),
  };
}

export function mapRoute(row: CanonicalControlRow): AppResponseRouteRecord {
  return {
    sessionId: String(column(row, 'session_id', 'sessionId')),
    threadId: String(column(row, 'thread_id', 'threadId') ?? ''),
    responseMode: column(
      row,
      'response_mode',
      'responseMode',
    ) as ControlResponseMode,
    webhookId: text(column(row, 'webhook_id', 'webhookId')),
    correlationId: text(column(row, 'correlation_id', 'correlationId')),
    updatedAt: String(column(row, 'updated_at', 'updatedAt')),
  };
}

export function mapEvent(row: CanonicalControlRow): ControlEventRecord {
  return {
    eventId: Number(column(row, 'event_id', 'eventId')),
    appId: String(column(row, 'app_id', 'appId')),
    eventType: String(column(row, 'event_type', 'eventType')),
    sessionId: text(column(row, 'session_id', 'sessionId')),
    jobId: text(column(row, 'job_id', 'jobId')),
    runId: text(column(row, 'run_id', 'runId')),
    triggerId: text(column(row, 'trigger_id', 'triggerId')),
    correlationId: text(column(row, 'correlation_id', 'correlationId')),
    actor: String(column(row, 'actor', 'actor')),
    payload: String(column(row, 'payload', 'payloadJson')),
    createdAt: String(column(row, 'created_at', 'createdAt')),
  };
}

export function mapWebhook(
  row: CanonicalControlRow,
): WebhookRegistrationRecord {
  return {
    webhookId: String(column(row, 'webhook_id', 'webhookId')),
    appId: String(column(row, 'app_id', 'appId')),
    name: String(column(row, 'name', 'name')),
    url: String(column(row, 'url', 'url')),
    enabled: Boolean(column(row, 'enabled', 'enabled')),
    eventTypes: stringArray(column(row, 'event_types', 'eventTypes')),
    agentId: text(column(row, 'agent_id', 'agentId')),
    sessionId: text(column(row, 'session_id', 'sessionId')),
    jobId: text(column(row, 'job_id', 'jobId')),
    createdAt: String(column(row, 'created_at', 'createdAt')),
    updatedAt: String(column(row, 'updated_at', 'updatedAt')),
  };
}

export function mapDelivery(row: CanonicalControlRow): WebhookDeliveryRecord {
  return {
    deliveryId: String(column(row, 'delivery_id', 'deliveryId')),
    webhookId: String(column(row, 'webhook_id', 'webhookId')),
    eventId: Number(column(row, 'event_id', 'eventId')),
    status: String(column(row, 'status', 'status')),
    attemptCount: Number(column(row, 'attempt_count', 'attemptCount')),
    nextAttemptAt: String(column(row, 'next_attempt_at', 'nextAttemptAt')),
    lastAttemptAt: text(column(row, 'last_attempt_at', 'lastAttemptAt')),
    deliveredAt: text(column(row, 'delivered_at', 'deliveredAt')),
    lastError: text(column(row, 'last_error', 'lastError')),
    createdAt: String(column(row, 'created_at', 'createdAt')),
    updatedAt: String(column(row, 'updated_at', 'updatedAt')),
  };
}

export function mapTrigger(row: CanonicalControlRow): JobTriggerRecord {
  return {
    triggerId: String(column(row, 'id', 'id')),
    jobId: String(column(row, 'job_id', 'jobId')),
    runId: text(column(row, 'run_id', 'runId')),
    requestedAt: String(column(row, 'requested_at', 'requestedAt')),
    requestedBy: String(column(row, 'requested_by', 'requestedBy')),
    status: String(column(row, 'status', 'status')),
    createdAt: String(column(row, 'created_at', 'createdAt')),
    updatedAt: String(column(row, 'updated_at', 'updatedAt')),
  };
}
