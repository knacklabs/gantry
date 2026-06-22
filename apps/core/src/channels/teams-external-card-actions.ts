import { createHmac, timingSafeEqual } from 'node:crypto';

import { envValueDynamic } from '../config/env/index.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { TeamsInboundMessage, TeamsSdkClient } from './teams.js';

export type ExternalCardAction = {
  integrationId: string;
  eventId: string;
  subjectId: string;
  scopeId: string;
  sourceScopeId?: string | null;
  sourceConversationId: string;
  teamsTenantId: string;
  actionType: string;
  platformOperation: string;
  requestId?: string | null;
  signatureVersion?: 'v2' | null;
  nonce: string;
  expiresAt: string;
  signature: string;
};

export async function handleExternalCardAction(input: {
  message: TeamsInboundMessage;
  sdkClient: TeamsSdkClient;
}): Promise<boolean> {
  const action = readExternalCardAction(input.message.value);
  if (!action) {
    logger.debug(
      {
        activityName: input.message.name,
        conversationId: input.message.conversationId,
        ...describeExternalCardActionParseMiss(input.message.value),
      },
      'Teams external card action payload ignored',
    );
    return false;
  }
  const actorId = input.message.senderId || input.message.from?.id;
  try {
    logger.info(
      {
        actionType: action.actionType,
        eventId: action.eventId,
        integrationId: action.integrationId,
        platformOperation: action.platformOperation,
        sourceConversationId: action.sourceConversationId,
        scopeId: action.scopeId,
      },
      'Teams external card action received',
    );
    if (!actorId || actorId === 'unknown') {
      throw new Error('Teams actor id is required for card actions');
    }
    if (
      input.message.senderIdKind &&
      !['aad_object_id', 'teams_user_id'].includes(input.message.senderIdKind)
    ) {
      throw new Error('A stable Teams actor id is required for card actions');
    }
    const teamsTenantId = input.message.tenantId?.trim();
    if (!teamsTenantId) {
      throw new Error('Teams tenant id is required for card actions');
    }
    if (action.teamsTenantId && action.teamsTenantId !== teamsTenantId) {
      throw new Error('This card action belongs to a different Teams tenant');
    }
    const conversationId = input.message.conversationId;
    const canonicalConversationId =
      canonicalTeamsConversationId(conversationId);
    if (
      !canonicalConversationId ||
        canonicalConversationId !==
        canonicalTeamsConversationId(action.sourceConversationId)
    ) {
      throw new Error(
        'This card action belongs to a different Teams conversation',
      );
    }
    verifyExternalCardActionSignature(action);
    await recordExternalCardActionStarted(action, actorId);
    await callExternalCardActionOperation({
      action,
      actorId,
      teamsTenantId,
      occurredAt: new Date().toISOString(),
    });
    logger.info(
      {
        actionType: action.actionType,
        eventId: action.eventId,
        integrationId: action.integrationId,
        platformOperation: action.platformOperation,
        sourceConversationId: action.sourceConversationId,
        scopeId: action.scopeId,
      },
      'Teams external card action forwarded to external platform',
    );
    await recordExternalCardActionFinished(action.nonce, 'completed');
    await input.sdkClient.sendMessage({
      conversationId,
      text: 'Action accepted.',
    });
  } catch (error) {
    logger.warn(
      {
        actionType: action.actionType,
        err: error,
        eventId: action.eventId,
        integrationId: action.integrationId,
        platformOperation: action.platformOperation,
        sourceConversationId: action.sourceConversationId,
        scopeId: action.scopeId,
      },
      'Teams external card action failed',
    );
    if (action) {
      await recordExternalCardActionFinished(
        action.nonce,
        'failed',
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
    }
    await input.sdkClient.sendMessage({
      conversationId: input.message.conversationId,
      text: `Action failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}

async function recordExternalCardActionStarted(
  action: ExternalCardAction,
  actorId: string,
): Promise<void> {
  const pool = getRuntimeStorage().service.pool;
  const event = await pool.query<{
    status: string;
    target_jid: string | null;
  }>(
    `SELECT status, target_jid
     FROM external_platform_events
     WHERE event_id = $1 AND integration_id = $2`,
    [action.eventId, action.integrationId],
  );
  const row = event.rows[0];
  if (!row) throw new Error('Card action event was not found');
  if (!['delivered', 'completed', 'callback_failed'].includes(row.status)) {
    throw new Error('Card action event has not been delivered');
  }
  if (row.target_jid !== `teams:${action.sourceConversationId}`) {
    throw new Error('Card action event belongs to a different channel');
  }
  const now = new Date().toISOString();
  const inserted = await pool.query(
    `INSERT INTO external_platform_card_actions
       (nonce, integration_id, event_id, action_type, actor_id, source_channel_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'started', $7, $7)
     ON CONFLICT (nonce) DO NOTHING`,
    [
      action.nonce,
      action.integrationId,
      action.eventId,
      action.actionType,
      actorId,
      action.sourceConversationId,
      now,
    ],
  );
  if (inserted.rowCount === 0) {
    throw new Error('Card action was already processed');
  }
}

async function recordExternalCardActionFinished(
  nonce: string,
  status: 'completed' | 'failed',
  error?: string,
): Promise<void> {
  await getRuntimeStorage().service.pool.query(
    `UPDATE external_platform_card_actions
     SET status = $2,
         error = $3,
         updated_at = $4
     WHERE nonce = $1`,
    [nonce, status, error ?? null, new Date().toISOString()],
  );
}

function readExternalCardAction(value: unknown): ExternalCardAction | null {
  if (!value || typeof value !== 'object') return null;
  const record = unwrapExternalCardActionValue(
    value as Record<string, unknown>,
  );
  if (!record) return null;
  if (record.action !== 'external_card_action') return null;
  const action = {
    integrationId: readString(record.integrationId),
    eventId: readString(record.eventId),
    subjectId: readString(record.subjectId),
    scopeId: readString(record.scopeId),
    sourceScopeId: readString(record.sourceScopeId) || null,
    sourceConversationId: readString(record.sourceConversationId),
    teamsTenantId: readString(record.teamsTenantId),
    actionType: readString(record.actionType),
    platformOperation: readString(record.platformOperation),
    requestId: readString(record.requestId) || null,
    signatureVersion:
      readString(record.signatureVersion) === 'v2' ? ('v2' as const) : null,
    nonce: readString(record.nonce),
    expiresAt: readString(record.expiresAt),
    signature: readString(record.signature),
  };
  const requiredValues = [
    action.integrationId,
    action.eventId,
    action.subjectId,
    action.scopeId,
    action.sourceConversationId,
    action.teamsTenantId,
    action.actionType,
    action.platformOperation,
    action.nonce,
    action.expiresAt,
    action.signature,
  ];
  if (requiredValues.some((value) => !value)) return null;
  return {
    ...action,
    expiresAt: normalizeExternalCardActionExpiresAtForSignature(
      action.expiresAt,
    ),
  } as ExternalCardAction;
}

function describeExternalCardActionParseMiss(value: unknown): {
  reason: string;
  valueKeys: string[];
  dataKeys?: string[];
} {
  if (!value || typeof value !== 'object') {
    return { reason: 'missing_or_non_object_value', valueKeys: [] };
  }
  const valueRecord = value as Record<string, unknown>;
  const record = unwrapExternalCardActionValue(valueRecord);
  if (!record) {
    return {
      reason: 'unsupported_payload_wrapper',
      valueKeys: diagnosticKeys(valueRecord),
    };
  }
  if (record.action !== 'external_card_action') {
    return {
      reason: 'missing_external_card_action_marker',
      valueKeys: diagnosticKeys(valueRecord),
      dataKeys: diagnosticKeys(record),
    };
  }
  const missingFields = [
    'integrationId',
    'eventId',
    'subjectId',
    'scopeId',
    'sourceConversationId',
    'teamsTenantId',
    'actionType',
    'platformOperation',
    'nonce',
    'expiresAt',
    'signature',
  ].filter((field) => !readString(record[field]));
  return {
    reason: missingFields.length
      ? `missing_fields:${missingFields.join(',')}`
      : 'unknown_parse_miss',
    valueKeys: diagnosticKeys(valueRecord),
    dataKeys: diagnosticKeys(record),
  };
}

function unwrapExternalCardActionValue(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  if (record.action === 'external_card_action') return record;
  const action = record.action;
  if (action && typeof action === 'object') {
    const actionRecord = action as Record<string, unknown>;
    if (actionRecord.data && typeof actionRecord.data === 'object') {
      return actionRecord.data as Record<string, unknown>;
    }
  }
  if (record.data && typeof record.data === 'object') {
    return record.data as Record<string, unknown>;
  }
  return null;
}

function verifyExternalCardActionSignature(action: ExternalCardAction): void {
  const expiresAt = normalizeExternalCardActionExpiresAtForSignature(
    action.expiresAt,
  );
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
    throw new Error('Card action has expired');
  }
  const secret =
    envValueDynamic('GANTRY_EXTERNAL_ACTION_SECRET') ||
    envValueDynamic('GANTRY_EXTERNAL_EVENT_SECRET');
  if (!secret)
    throw new Error('GANTRY_EXTERNAL_ACTION_SECRET is not configured');
  const expected = createHmac('sha256', secret)
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries({
            integrationId: action.integrationId,
            eventId: action.eventId,
            subjectId: action.subjectId,
            scopeId: action.scopeId,
            sourceScopeId: action.sourceScopeId ?? action.scopeId,
            sourceConversationId: action.sourceConversationId,
            teamsTenantId: action.teamsTenantId,
            actionType: action.actionType,
            nonce: action.nonce,
            expiresAt,
            ...(action.signatureVersion === 'v2'
              ? {
                  signatureVersion: 'v2',
                  platformOperation: action.platformOperation,
                  requestId: action.requestId ?? null,
                }
              : {}),
          }).sort(),
        ),
      ),
    )
    .digest('hex');
  const left = Buffer.from(expected);
  const right = Buffer.from(action.signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error('Invalid card action signature');
  }
}

function normalizeExternalCardActionExpiresAtForSignature(
  expiresAt: string,
): string {
  const parsed = Date.parse(expiresAt.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error('External card action expiration timestamp is invalid');
  }
  return new Date(parsed).toISOString();
}

async function callExternalCardActionOperation(input: {
  action: ExternalCardAction;
  actorId: string;
  teamsTenantId: string;
  occurredAt: string;
}): Promise<void> {
  const request = buildExternalCardActionGraphqlRequest(input);
  const response = await fetch(resolveExternalGraphqlUrl(), {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(
      Number(envValueDynamic('GANTRY_EXTERNAL_ACTION_TIMEOUT_MS')) || 5000,
    ),
  });
  if (!response.ok) {
    throw new Error(`External platform API returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    errors?: Array<{ message?: unknown }>;
  };
  if (payload.errors?.length) {
    throw new Error(
      typeof payload.errors[0]?.message === 'string'
        ? payload.errors[0].message
        : 'GraphQL operation failed',
    );
  }
}

export function buildExternalCardActionGraphqlRequest(input: {
  action: ExternalCardAction;
  actorId: string;
  teamsTenantId: string;
  occurredAt: string;
}): {
  headers: Record<string, string>;
  body: {
    query: string;
    variables: {
      input: {
        integrationId: string;
        eventId: string;
        subjectId: string;
        scopeId: string;
        sourceScopeId: string;
        sourceConversationId: string;
        teamsTenantId: string;
        actionType: string;
        platformOperation: string;
        actorId: string;
        nonce: string;
        occurredAt: string;
      };
    };
  };
} {
  return {
    headers: {
      authorization: `Bearer ${resolveExternalPlatformServiceToken()}`,
      'content-type': 'application/json',
      'x-channel-id': input.action.sourceConversationId,
      'x-integration-id': input.action.integrationId,
    },
    body: {
      query: `
        mutation HandleExternalCardAction($input: ExternalCardActionInput!) {
          handleExternalCardAction(input: $input) { accepted }
        }
      `,
      variables: {
        input: {
          integrationId: input.action.integrationId,
          eventId: input.action.eventId,
          subjectId: input.action.subjectId,
          scopeId: input.action.scopeId,
          sourceScopeId: input.action.sourceScopeId ?? input.action.scopeId,
          sourceConversationId: input.action.sourceConversationId,
          teamsTenantId: input.teamsTenantId,
          actionType: input.action.actionType,
          platformOperation: input.action.platformOperation,
          actorId: input.actorId,
          nonce: input.action.nonce,
          occurredAt: input.occurredAt,
        },
      },
    },
  };
}

function resolveExternalGraphqlUrl(): string {
  const explicit = envValueDynamic('GANTRY_EXTERNAL_PLATFORM_GRAPHQL_URL');
  if (explicit) return explicit;
  throw new Error('GANTRY_EXTERNAL_PLATFORM_GRAPHQL_URL is not configured');
}

function resolveExternalPlatformServiceToken(): string {
  const explicit =
    envValueDynamic('GANTRY_EXTERNAL_PLATFORM_SERVICE_TOKEN') ||
    envValueDynamic('AGENT_CONVERSATION_SERVICE_TOKEN') ||
    envValueDynamic('AGENT_RUNTIME_CONVERSATION_SERVICE_TOKEN') ||
    envValueDynamic('OPENCLAW_CONVERSATION_SERVICE_TOKEN');
  if (explicit) return explicit;
  return 'service:agent_conversation';
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function canonicalTeamsConversationId(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  return raw.split(';')[0]?.trim() || null;
}

function diagnosticKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .slice(0, 20);
}

export const _testExternalCardActions = {
  canonicalTeamsConversationId,
  describeExternalCardActionParseMiss,
  readExternalCardAction,
  verifyExternalCardActionSignature,
};
