import { createHmac, timingSafeEqual } from 'node:crypto';

import { envValueDynamic } from '../config/env/index.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import type { TeamsInboundMessage, TeamsSdkClient } from './teams.js';

type ExternalCardAction = {
  integrationId: string;
  eventId: string;
  resourceId: string;
  workspaceId: string;
  sourceChannelId: string;
  actionType: string;
  platformOperation: string;
  nonce: string;
  expiresAt: string;
  signature: string;
};

export async function handleExternalCardAction(input: {
  message: TeamsInboundMessage;
  sdkClient: TeamsSdkClient;
}): Promise<boolean> {
  const action = readExternalCardAction(input.message.value);
  if (!action) return false;
  const actorId = input.message.senderId || input.message.from?.id;
  try {
    if (!actorId || actorId === 'unknown') {
      throw new Error('Teams actor id is required for card actions');
    }
    const conversationId = input.message.conversationId;
    if (conversationId !== action.sourceChannelId) {
      throw new Error(
        'This card action belongs to a different Teams conversation',
      );
    }
    verifyExternalCardActionSignature(action);
    await recordExternalCardActionStarted(action, actorId);
    await callExternalCardActionOperation({
      action,
      actorId,
      occurredAt: new Date().toISOString(),
    });
    await recordExternalCardActionFinished(action.nonce, 'completed');
    await input.sdkClient.sendMessage({
      conversationId,
      text: 'Action accepted.',
    });
  } catch (error) {
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
  if (row.target_jid !== `teams:${action.sourceChannelId}`) {
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
      action.sourceChannelId,
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
  const record = value as Record<string, unknown>;
  if (record.action !== 'external_card_action') return null;
  const action = {
    integrationId: readString(record.integrationId),
    eventId: readString(record.eventId),
    resourceId: readString(record.resourceId),
    workspaceId: readString(record.workspaceId),
    sourceChannelId: readString(record.sourceChannelId),
    actionType: readString(record.actionType),
    platformOperation: readString(record.platformOperation),
    nonce: readString(record.nonce),
    expiresAt: readString(record.expiresAt),
    signature: readString(record.signature),
  };
  if (Object.values(action).some((value) => !value)) return null;
  return action as ExternalCardAction;
}

function verifyExternalCardActionSignature(action: ExternalCardAction): void {
  const expiresAtMs = Date.parse(action.expiresAt);
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
            resourceId: action.resourceId,
            workspaceId: action.workspaceId,
            sourceChannelId: action.sourceChannelId,
            actionType: action.actionType,
            nonce: action.nonce,
            expiresAt: action.expiresAt,
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

async function callExternalCardActionOperation(input: {
  action: ExternalCardAction;
  actorId: string;
  occurredAt: string;
}): Promise<void> {
  const response = await fetch(resolveExternalGraphqlUrl(), {
    method: 'POST',
    headers: {
      authorization: 'Bearer service:external_integration',
      'content-type': 'application/json',
      'x-channel-id': input.action.sourceChannelId,
      'x-integration-id': input.action.integrationId,
    },
    body: JSON.stringify({
      query: `
        mutation HandleExternalCardAction($input: ExternalCardActionInput!) {
          handleExternalCardAction(input: $input) { accepted }
        }
      `,
      variables: {
        input: {
          integrationId: input.action.integrationId,
          eventId: input.action.eventId,
          resourceId: input.action.resourceId,
          workspaceId: input.action.workspaceId,
          sourceChannelId: input.action.sourceChannelId,
          actionType: input.action.actionType,
          platformOperation: input.action.platformOperation,
          actorId: input.actorId,
          nonce: input.action.nonce,
          occurredAt: input.occurredAt,
        },
      },
    }),
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

function resolveExternalGraphqlUrl(): string {
  const explicit = envValueDynamic('GANTRY_EXTERNAL_PLATFORM_GRAPHQL_URL');
  if (explicit) return explicit;
  throw new Error('GANTRY_EXTERNAL_PLATFORM_GRAPHQL_URL is not configured');
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
