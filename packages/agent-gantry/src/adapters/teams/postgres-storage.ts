import type {
  GantryPgRuntimeStorageConfig,
  GantryRuntimeStorage,
  GantryTeamsStoredConversationReference,
  GantryUserConversationState,
  GantryUserConversationStateKey,
} from './types.js';
import { asRecord, requireNonEmpty } from '../../shared/helpers.js';

export function createPgGantryRuntimeStorage(
  config: GantryPgRuntimeStorageConfig,
): GantryRuntimeStorage {
  const schema = normalizeSqlIdentifier(config.schema ?? 'gantry_runtime');
  return {
    recordMessage: async (input) => {
      await config.pool.query(
        `insert into "${schema}"."runtime_messages" (provider, conversation_id, message_id, sender_id, text, payload_json, occurred_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
         on conflict (provider, message_id) do nothing`,
        [
          input.provider,
          input.conversationId,
          input.messageId,
          input.senderId ?? null,
          input.text ?? null,
          JSON.stringify(input.payload ?? {}),
          input.occurredAt,
        ],
      );
    },
    recordStructuredTaskRun: async (input) => {
      await config.pool.query(
        `insert into "${schema}"."structured_task_runs" (task_run_id, task_type, correlation_id, status, input_json, output_json, validation_report_json, error, occurred_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         on conflict (task_run_id) do nothing`,
        [
          input.taskRunId,
          input.taskType,
          input.correlationId ?? null,
          input.status,
          JSON.stringify(input.input),
          JSON.stringify(input.output ?? {}),
          JSON.stringify(input.validationReport ?? {}),
          input.error ?? null,
          input.occurredAt,
        ],
      );
    },
    getUserConversationState: async (input) => {
      const key = normalizeUserConversationStateKey(input);
      const result = await config.pool.query(
        `select provider, tenant_id, user_id, conversation_id, conversation_scope_type, conversation_scope_id,
                summary_text, state_json, last_subject_id, last_seen_at, expires_at, created_at, updated_at
         from "${schema}"."user_conversation_state"
         where provider = $1
           and tenant_id = $2
           and user_id = $3
           and conversation_id = $4
           and conversation_scope_type = $5
           and conversation_scope_id = $6
           and expires_at > now()
         limit 1`,
        [
          key.provider,
          key.tenantId,
          key.userId,
          key.conversationId,
          key.conversationScopeType,
          key.conversationScopeId,
        ],
      );
      return mapUserConversationStateRow(result.rows[0]);
    },
    upsertUserConversationState: async (input) => {
      const key = normalizeUserConversationStateKey(input);
      const updatedAt = input.updatedAt ?? input.lastSeenAt;
      const result = await config.pool.query(
        `insert into "${schema}"."user_conversation_state" (
            provider, tenant_id, user_id, conversation_id, conversation_scope_type, conversation_scope_id,
            summary_text, state_json, last_subject_id, last_seen_at, expires_at, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, coalesce($12::timestamptz, now()), $12)
          on conflict (provider, tenant_id, user_id, conversation_id, conversation_scope_type, conversation_scope_id)
          do update set
            summary_text = excluded.summary_text,
            state_json = excluded.state_json,
            last_subject_id = excluded.last_subject_id,
            last_seen_at = excluded.last_seen_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
          returning provider, tenant_id, user_id, conversation_id, conversation_scope_type, conversation_scope_id,
                    summary_text, state_json, last_subject_id, last_seen_at, expires_at, created_at, updated_at`,
        [
          key.provider,
          key.tenantId,
          key.userId,
          key.conversationId,
          key.conversationScopeType,
          key.conversationScopeId,
          input.summaryText ?? '',
          JSON.stringify(input.stateJson ?? {}),
          input.lastSubjectId ?? null,
          input.lastSeenAt,
          input.expiresAt,
          updatedAt,
        ],
      );
      return requireUserConversationStateRow(result.rows[0]);
    },
    mergeUserConversationState: async (input) => {
      const key = normalizeUserConversationStateKey(input);
      const updatedAt = input.updatedAt ?? input.lastSeenAt;
      const result = await config.pool.query(
        `insert into "${schema}"."user_conversation_state" (
            provider, tenant_id, user_id, conversation_id, conversation_scope_type, conversation_scope_id,
            summary_text, state_json, last_subject_id, last_seen_at, expires_at, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, coalesce($12::timestamptz, now()), $12)
          on conflict (provider, tenant_id, user_id, conversation_id, conversation_scope_type, conversation_scope_id)
          do update set
            summary_text = case
              when excluded.summary_text = '' then "${schema}"."user_conversation_state".summary_text
              when "${schema}"."user_conversation_state".summary_text = '' then excluded.summary_text
              else left("${schema}"."user_conversation_state".summary_text || E'\n' || excluded.summary_text, 2000)
            end,
            state_json = "${schema}"."user_conversation_state".state_json || excluded.state_json,
            last_subject_id = coalesce(excluded.last_subject_id, "${schema}"."user_conversation_state".last_subject_id),
            last_seen_at = greatest("${schema}"."user_conversation_state".last_seen_at, excluded.last_seen_at),
            expires_at = greatest("${schema}"."user_conversation_state".expires_at, excluded.expires_at),
            updated_at = greatest("${schema}"."user_conversation_state".updated_at, excluded.updated_at)
          returning provider, tenant_id, user_id, conversation_id, conversation_scope_type, conversation_scope_id,
                    summary_text, state_json, last_subject_id, last_seen_at, expires_at, created_at, updated_at`,
        [
          key.provider,
          key.tenantId,
          key.userId,
          key.conversationId,
          key.conversationScopeType,
          key.conversationScopeId,
          input.summaryText ?? '',
          JSON.stringify(input.stateJson ?? {}),
          input.lastSubjectId ?? null,
          input.lastSeenAt,
          input.expiresAt,
          updatedAt,
        ],
      );
      return requireUserConversationStateRow(result.rows[0]);
    },
    getTeamsConversationReference: async (conversationId) => {
      const trimmed = conversationId.trim();
      const canonicalConversationId = canonicalTeamsConversationId(trimmed);
      const normalized = normalizeTeamsJid(canonicalConversationId);
      const originalJid = normalizeTeamsJid(trimmed);
      const result = await config.pool.query(
        `select conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at
         from "${schema}"."teams_conversation_references"
         where conversation_jid in ($1, $2)
            or conversation_id in ($3, $4)
            or regexp_replace(conversation_jid, ';messageid=.*$', '', 'i') = $1
            or regexp_replace(conversation_id, ';messageid=.*$', '', 'i') = $3
         order by case
            when conversation_jid = $1 or conversation_id = $3 then 0
            when conversation_jid = $2 or conversation_id = $4 then 1
            else 2
          end,
          updated_at desc
         limit 1`,
        [normalized, originalJid, canonicalConversationId, trimmed],
      );
      return mapTeamsReferenceRow(
        result.rows[0],
        canonicalConversationId || trimmed,
      );
    },
    getTeamsPersonalConversationReference: async (input) => {
      const result = await config.pool.query(
        `select conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at
         from "${schema}"."teams_conversation_references"
         where teams_user_id = $1 and ($2::text is null or tenant_id = $2)
         order by updated_at desc
         limit 1`,
        [input.teamsUserId, input.teamsTenantId ?? null],
      );
      return mapTeamsReferenceRow(result.rows[0], input.teamsUserId);
    },
    saveTeamsConversationReference: async (reference) => {
      await config.pool.query(
        `insert into "${schema}"."teams_conversation_references" (conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
         on conflict (conversation_jid) do update set
           conversation_id = excluded.conversation_id,
           service_url = excluded.service_url,
           tenant_id = excluded.tenant_id,
           bot_id = excluded.bot_id,
           teams_user_id = excluded.teams_user_id,
           raw_reference_json = excluded.raw_reference_json,
           updated_at = excluded.updated_at`,
        [
          reference.conversationJid ??
            normalizeTeamsJid(reference.conversationId),
          reference.conversationId,
          reference.serviceUrl ?? null,
          reference.tenantId ?? null,
          reference.botId ?? null,
          reference.teamsUserId ?? null,
          reference.rawReferenceJson ?? null,
          reference.updatedAt ?? null,
        ],
      );
    },
  };
}

function normalizeTeamsJid(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('teams:') ? trimmed : `teams:${trimmed}`;
}

function canonicalTeamsConversationId(conversationId: string): string {
  const trimmed = conversationId.trim();
  const messageIdIndex = trimmed.toLowerCase().indexOf(';messageid=');
  if (messageIdIndex < 0) return trimmed;
  return trimmed.slice(0, messageIdIndex).trim() || trimmed;
}

function normalizeSqlIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return normalized;
}

function mapTeamsReferenceRow(
  row: Record<string, unknown> | undefined,
  fallbackConversationId: string,
): GantryTeamsStoredConversationReference | null {
  if (!row) return null;
  return {
    exists: true,
    conversationId: String(row.conversation_id ?? fallbackConversationId),
    conversationJid:
      typeof row.conversation_jid === 'string' ? row.conversation_jid : null,
    serviceUrl: typeof row.service_url === 'string' ? row.service_url : null,
    tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
    botId: typeof row.bot_id === 'string' ? row.bot_id : null,
    teamsUserId:
      typeof row.teams_user_id === 'string' ? row.teams_user_id : null,
    rawReferenceJson:
      typeof row.raw_reference_json === 'string'
        ? row.raw_reference_json
        : null,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : typeof row.updated_at === 'string'
          ? row.updated_at
          : null,
  };
}

function normalizeUserConversationStateKey(
  input: GantryUserConversationStateKey,
): GantryUserConversationStateKey {
  return {
    provider: requireNonEmpty(input.provider, 'provider'),
    tenantId: requireNonEmpty(input.tenantId, 'tenantId'),
    userId: requireNonEmpty(input.userId, 'userId'),
    conversationId: requireNonEmpty(input.conversationId, 'conversationId'),
    conversationScopeType: requireNonEmpty(
      input.conversationScopeType,
      'conversationScopeType',
    ),
    conversationScopeId: requireNonEmpty(
      input.conversationScopeId,
      'conversationScopeId',
    ),
  };
}

function requireUserConversationStateRow(
  row: Record<string, unknown> | undefined,
): GantryUserConversationState {
  const mapped = mapUserConversationStateRow(row);
  if (!mapped) {
    throw new Error(
      'Gantry user conversation state upsert did not return a row.',
    );
  }
  return mapped;
}

function mapUserConversationStateRow(
  row: Record<string, unknown> | undefined,
): GantryUserConversationState | null {
  if (!row) return null;
  return {
    provider: String(row.provider ?? ''),
    tenantId: String(row.tenant_id ?? ''),
    userId: String(row.user_id ?? ''),
    conversationId: String(row.conversation_id ?? ''),
    conversationScopeType: String(row.conversation_scope_type ?? ''),
    conversationScopeId: String(row.conversation_scope_id ?? ''),
    summaryText: typeof row.summary_text === 'string' ? row.summary_text : '',
    stateJson: asRecord(row.state_json) ?? {},
    lastSubjectId:
      typeof row.last_subject_id === 'string' ? row.last_subject_id : null,
    lastSeenAt: normalizeDateLike(row.last_seen_at),
    expiresAt: normalizeDateLike(row.expires_at),
    createdAt: normalizeDateLike(row.created_at),
    updatedAt: normalizeDateLike(row.updated_at),
  };
}

function normalizeDateLike(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : '';
}
