import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { envValueDynamic } from '../../../config/env/index.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { PostgresCanonicalGraphRepository } from '../../../adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import type { ControlRouteContext } from '../handler-context.js';
import { readRawBody, sendError, sendJson } from '../http.js';
import {
  buildExternalNotificationAdaptiveCard,
  fallbackTextForNotificationCard,
  type ExternalPlatformDelivery,
  type PlatformEventEnvelope,
} from './external-notification-card.js';
import type { MessageDeliveryResult } from '../../../domain/types.js';

const EXTERNAL_EVENTS_PATH = '/v1/integrations/platform-events';
const MAX_BODY_BYTES = 256 * 1024;
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;
const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_MAX_ATTEMPTS = 5;
const DELIVERY_RETRY_BASE_DELAY_MS = 5000;
const DELIVERY_RETRY_MAX_DELAY_MS = 60_000;
const EVENT_TYPES = new Set([
  'notification.card.requested',
  'notification.message.requested',
]);

type ExternalPlatformEventRow = {
  event_id: string;
  event_type: string;
  target_jid: string | null;
  status: string;
  payload_json: string;
  error: string | null;
  attempt_count: number;
};

export async function handleExternalPlatformEventRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname !== EXTERNAL_EVENTS_PATH) return false;
  if (req.method !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }

  const secret = envValueDynamic('GANTRY_EXTERNAL_EVENT_SECRET');
  if (!secret) {
    sendError(
      res,
      503,
      'RUNTIME_NOT_CONFIGURED',
      'GANTRY_EXTERNAL_EVENT_SECRET is not configured',
    );
    return true;
  }

  const headers = readExternalSignatureHeaders(req, res);
  if (!headers) return true;
  const rawBody = await readExternalRawBody(req, res);
  if (rawBody === null) return true;

  if (
    !verifyExternalEventSignature({
      secret,
      method: req.method,
      path: pathname,
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      rawBody,
      signature: headers.signature,
    })
  ) {
    sendError(
      res,
      403,
      'FORBIDDEN',
      'Invalid External platform event signature',
    );
    return true;
  }

  const envelope = parseExternalEnvelope(rawBody);
  if (!envelope.ok) {
    sendError(res, 400, 'INVALID_REQUEST', envelope.error);
    return true;
  }

  const accepted = await acceptExternalEvent(ctx, envelope.value, rawBody);
  sendJson(res, 202, accepted);
  return true;
}

export function signExternalEventRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(buildExternalSignaturePayload(input))
    .digest('hex');
}

export function signGantryDeliveryStatusRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(buildExternalSignaturePayload(input))
    .digest('hex');
}

export function verifyExternalEventSignature(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  signature: string;
  nowMs?: number;
}): boolean {
  const timestampMs = Number(input.timestamp);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs((input.nowMs ?? Date.now()) - timestampMs) > SIGNATURE_TOLERANCE_MS
  ) {
    return false;
  }
  const expected = signExternalEventRequest(input);
  const left = Buffer.from(expected);
  const right = Buffer.from(input.signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildExternalPlatformMessage(
  envelope: PlatformEventEnvelope,
): string {
  const payload = envelope.payload;
  if (envelope.eventType === 'notification.message.requested') {
    const message =
      readOptionalString(payload.message) ??
      readOptionalString(payload.text) ??
      readOptionalString(payload.fallbackText);
    if (message) return message;
    const title = readOptionalString(payload.title) ?? 'New notification';
    const summary =
      readOptionalString(payload.summary) ??
      readOptionalString(payload.description);
    return [title, summary].filter(Boolean).join('\n');
  }
  if (envelope.eventType === 'notification.card.requested') {
    const card = readRecord(payload.notificationCard);
    const title =
      readOptionalString(card?.title) ??
      readOptionalString(payload.title) ??
      'New notification';
    const summary =
      readOptionalString(card?.summary) ??
      readOptionalString(payload.noticeSummary);
    const facts = readMessageFacts(card?.facts);
    return [
      `Notification: ${title}`,
      summary ? `Summary: ${summary}` : undefined,
      ...facts,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return `External platform event received: ${envelope.eventType}`;
}

export function buildExternalPlatformDelivery(
  envelope: PlatformEventEnvelope,
): ExternalPlatformDelivery {
  const card = buildExternalNotificationAdaptiveCard(envelope);
  if (card) {
    return {
      kind: 'adaptive_card',
      card,
      fallbackText:
        fallbackTextForNotificationCard(envelope) ??
        buildExternalPlatformMessage(envelope),
    };
  }
  return {
    kind: 'text',
    message: buildExternalPlatformMessage(envelope),
    threadId: resolveExternalThreadId(envelope),
  };
}

function readMessageFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    const label =
      readOptionalString(record?.label) ?? readOptionalString(record?.title);
    const factValue = readOptionalString(record?.value);
    return label && factValue ? [`${label}: ${factValue}`] : [];
  });
}

function buildExternalSignaturePayload(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return [
    input.method.trim().toUpperCase(),
    input.path.trim(),
    input.timestamp.trim(),
    input.nonce.trim(),
    input.rawBody,
  ].join('\n');
}

function readExternalSignatureHeaders(
  req: IncomingMessage,
  res: ServerResponse,
): { timestamp: string; nonce: string; signature: string } | null {
  const timestamp = header(req, 'x-gantry-external-event-timestamp');
  const nonce = header(req, 'x-gantry-external-event-nonce');
  const signature = header(req, 'x-gantry-external-event-signature');
  const missing = [
    ['x-gantry-external-event-timestamp', timestamp],
    ['x-gantry-external-event-nonce', nonce],
    ['x-gantry-external-event-signature', signature],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      `Missing required External event signature header: ${missing.join(', ')}`,
    );
    return null;
  }
  return { timestamp, nonce, signature };
}

async function readExternalRawBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string | null> {
  try {
    return (await readRawBody(req, MAX_BODY_BYTES)).toString('utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 413
    ) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
      return null;
    }
    throw error;
  }
}

function parseExternalEnvelope(
  rawBody: string,
): { ok: true; value: PlatformEventEnvelope } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: 'Invalid JSON body' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Event envelope must be an object' };
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.integrationId !== 'string' ||
    !record.integrationId.trim()
  ) {
    return { ok: false, error: 'integrationId is required' };
  }
  if (typeof record.eventId !== 'string' || !record.eventId.trim()) {
    return { ok: false, error: 'eventId is required' };
  }
  if (
    typeof record.eventType !== 'string' ||
    !EVENT_TYPES.has(record.eventType)
  ) {
    return { ok: false, error: 'eventType is invalid' };
  }
  if (typeof record.occurredAt !== 'string' || !record.occurredAt.trim()) {
    return { ok: false, error: 'occurredAt is required' };
  }
  if (
    !record.payload ||
    typeof record.payload !== 'object' ||
    Array.isArray(record.payload)
  ) {
    return { ok: false, error: 'payload is required' };
  }
  return {
    ok: true,
    value: {
      eventId: record.eventId.trim(),
      integrationId: record.integrationId.trim(),
      eventType: record.eventType,
      occurredAt: record.occurredAt.trim(),
      target:
        record.target && typeof record.target === 'object'
          ? (record.target as Record<string, unknown>)
          : undefined,
      payload: record.payload as Record<string, unknown>,
    },
  };
}

async function acceptExternalEvent(
  ctx: ControlRouteContext,
  envelope: PlatformEventEnvelope,
  rawBody: string,
) {
  const now = new Date().toISOString();
  const targetJid = resolveTargetJid(envelope);
  const insert = await getRuntimeStorage().service.pool.query<{
    event_id: string;
  }>(
    `INSERT INTO external_platform_events
       (event_id, integration_id, event_type, target_jid, status, payload_json, attempt_count, received_at, updated_at)
     VALUES ($1, $2, $3, $4, 'accepted', $5, 0, $6, $6)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      envelope.eventId,
      envelope.integrationId,
      envelope.eventType,
      targetJid,
      rawBody,
      now,
    ],
  );
  const duplicate = insert.rowCount === 0;
  if (!duplicate) {
    if (targetJid) {
      await dispatchExternalEventToRuntime(ctx, envelope, targetJid);
    }
  }
  return {
    accepted: true,
    duplicate,
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    targetJid,
  };
}

async function dispatchExternalEventToRuntime(
  ctx: ControlRouteContext,
  envelope: PlatformEventEnvelope,
  targetJid: string,
): Promise<void> {
  try {
    await ensureExternalRuntimeConversation(targetJid);
    const deliveryResult = await sendExternalDelivery(
      ctx,
      targetJid,
      buildExternalPlatformDelivery(envelope),
    );
    const deliveryMetadata = externalDeliveryMetadata(
      targetJid,
      deliveryResult,
    );
    const deliveredAt = new Date().toISOString();
    await updateExternalEventStatus({
      eventId: envelope.eventId,
      status: 'delivered',
      error: null,
      response: {
        targetJid,
        ...deliveryMetadata,
      },
      attemptCount: 0,
      nextAttemptAt: deliveredAt,
      deliveredAt,
    });
    await completeExternalDeliveryCallback({
      eventId: envelope.eventId,
      platformStatus: 'delivered',
      deliveredAt,
      response: { targetJid, ...deliveryMetadata },
      ...deliveryMetadata,
    });
  } catch (error) {
    await markExternalEventRetry({
      eventId: envelope.eventId,
      status: 'accepted',
      attemptCount: 0,
      error: error instanceof Error ? error.message : String(error),
      response: {
        targetJid,
      },
    });
  }
}

async function sendExternalDelivery(
  ctx: ControlRouteContext,
  targetJid: string,
  delivery: ExternalPlatformDelivery,
): Promise<MessageDeliveryResult | void> {
  if (delivery.kind === 'adaptive_card' && ctx.app.sendChannelAdaptiveCard) {
    return (await ctx.app.sendChannelAdaptiveCard(targetJid, delivery.card, {
      durability: 'required',
      fallbackText: delivery.fallbackText,
      throwOnMissing: true,
      ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
    })) as MessageDeliveryResult | void;
  }
  if (delivery.kind === 'adaptive_card') {
    throw new Error('Adaptive Card delivery is required but unavailable');
  }
  return await ctx.app.sendChannelMessage(targetJid, delivery.message, {
    ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
  });
}

async function ensureExternalRuntimeConversation(
  targetJid: string,
): Promise<void> {
  const provider = targetJid.startsWith('teams:') ? 'teams' : undefined;
  const isDirectTeamsConversation = targetJid.startsWith('teams:a:');
  const graph = new PostgresCanonicalGraphRepository(
    getRuntimeStorage().service.db,
  );
  await graph.ensureConversation(targetJid, {
    channel: provider,
    isGroup: !isDirectTeamsConversation,
    name: targetJid,
  });
}

async function updateExternalEventStatus(input: {
  eventId: string;
  status: string;
  error: string | null;
  response: unknown;
  attemptCount: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}): Promise<void> {
  await getRuntimeStorage().service.pool.query(
    `UPDATE external_platform_events
     SET status = $2,
         error = $3,
         response_json = $4,
         attempt_count = $5,
         next_attempt_at = $6,
         delivered_at = COALESCE($7, delivered_at),
         updated_at = $8
     WHERE event_id = $1`,
    [
      input.eventId,
      input.status,
      input.error,
      JSON.stringify(input.response ?? {}),
      input.attemptCount,
      input.nextAttemptAt,
      input.deliveredAt,
      new Date().toISOString(),
    ],
  );
}

async function markExternalEventRetry(input: {
  eventId: string;
  status: 'accepted' | 'delivered' | 'failed';
  attemptCount: number;
  error: string;
  response: unknown;
}): Promise<void> {
  const nextAttemptCount = input.attemptCount + 1;
  if (nextAttemptCount >= DELIVERY_MAX_ATTEMPTS) {
    const finalStatus =
      input.status === 'accepted'
        ? 'failed'
        : input.status === 'failed'
          ? 'callback_failed'
          : 'callback_failed';
    const deliveredAt =
      input.status === 'accepted' ? new Date().toISOString() : null;
    await updateExternalEventStatus({
      eventId: input.eventId,
      status: finalStatus,
      error: input.error,
      response: input.response,
      attemptCount: 0,
      nextAttemptAt: finalStatus === 'failed' ? new Date().toISOString() : null,
      deliveredAt,
    });
    if (finalStatus === 'failed') {
      const failureDeliveredAt = deliveredAt ?? new Date().toISOString();
      await completeExternalDeliveryCallback({
        eventId: input.eventId,
        platformStatus: 'failed',
        deliveredAt: failureDeliveredAt,
        error: input.error,
        response: input.response,
      });
    }
    return;
  }

  await updateExternalEventStatus({
    eventId: input.eventId,
    status: input.status,
    error: input.error,
    response: input.response,
    attemptCount: nextAttemptCount,
    nextAttemptAt: new Date(
      Date.now() + resolveExternalDeliveryRetryDelayMs(input.attemptCount),
    ).toISOString(),
    deliveredAt: null,
  });
}

async function completeExternalDeliveryCallback(input: {
  eventId: string;
  platformStatus: 'delivered' | 'failed';
  deliveredAt: string;
  error?: string | null;
  response: unknown;
  attemptCount?: number;
  teamsMessageId?: string | null;
  conversationId?: string | null;
}): Promise<void> {
  try {
    await sendExternalDeliveryCallback({
      eventId: input.eventId,
      status: input.platformStatus,
      deliveredAt: input.deliveredAt,
      error: input.error ?? null,
      teamsMessageId: input.teamsMessageId ?? null,
      conversationId: input.conversationId ?? null,
    });
    await updateExternalEventStatus({
      eventId: input.eventId,
      status: 'completed',
      error: null,
      response: input.response,
      attemptCount: 0,
      nextAttemptAt: null,
      deliveredAt: input.deliveredAt,
    });
  } catch (error) {
    await markExternalEventRetry({
      eventId: input.eventId,
      status: input.platformStatus === 'delivered' ? 'delivered' : 'failed',
      attemptCount: input.attemptCount ?? 0,
      error: error instanceof Error ? error.message : String(error),
      response: input.response,
    });
  }
}

async function sendExternalDeliveryCallback(input: {
  eventId: string;
  status: 'delivered' | 'failed';
  deliveredAt: string;
  error?: string | null;
  teamsMessageId?: string | null;
  conversationId?: string | null;
}): Promise<void> {
  const callbackUrl = envValueDynamic('GANTRY_EXTERNAL_DELIVERY_STATUS_URL');
  if (!callbackUrl) {
    throw new Error('GANTRY_EXTERNAL_DELIVERY_STATUS_URL is not configured');
  }
  const secret =
    envValueDynamic('GANTRY_EXTERNAL_DELIVERY_STATUS_SECRET') ||
    envValueDynamic('GANTRY_EXTERNAL_EVENT_SECRET');
  if (!secret) {
    throw new Error('GANTRY_EXTERNAL_DELIVERY_STATUS_SECRET is not configured');
  }
  const body = JSON.stringify({
    eventId: input.eventId,
    status: input.status,
    deliveredAt: input.deliveredAt,
    ...(input.teamsMessageId ? { teamsMessageId: input.teamsMessageId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
  const url = new URL(callbackUrl);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = signGantryDeliveryStatusRequest({
    secret,
    method: 'POST',
    path: url.pathname,
    timestamp,
    nonce,
    rawBody: body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gantry-delivery-status-timestamp': timestamp,
      'x-gantry-delivery-status-nonce': nonce,
      'x-gantry-delivery-status-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(
      Number(envValueDynamic('GANTRY_EXTERNAL_DELIVERY_STATUS_TIMEOUT_MS')) ||
        5000,
    ),
  });
  if (!response.ok) {
    throw new Error(
      `External delivery status callback failed (${response.status})`,
    );
  }
}

export async function flushExternalPlatformEventDeliveries(
  ctx: ControlRouteContext,
): Promise<void> {
  const rows =
    await getRuntimeStorage().service.pool.query<ExternalPlatformEventRow>(
      `SELECT event_id, event_type, target_jid, status, payload_json, error, attempt_count
     FROM external_platform_events
     WHERE target_jid IS NOT NULL
       AND status IN ('accepted', 'delivered', 'failed')
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
     ORDER BY updated_at ASC
     LIMIT $1`,
      [DELIVERY_BATCH_SIZE],
    );

  for (const row of rows.rows) {
    await processExternalPlatformEventDelivery(ctx, row);
  }
}

async function processExternalPlatformEventDelivery(
  ctx: ControlRouteContext,
  row: ExternalPlatformEventRow,
): Promise<void> {
  if (row.status === 'delivered' || row.status === 'failed') {
    await completeExternalDeliveryCallback({
      eventId: row.event_id,
      platformStatus: row.status === 'delivered' ? 'delivered' : 'failed',
      deliveredAt: new Date().toISOString(),
      error: row.status === 'failed' ? row.error : null,
      response: { targetJid: row.target_jid },
      attemptCount: row.attempt_count,
    });
    return;
  }

  let envelope: PlatformEventEnvelope;
  try {
    envelope = JSON.parse(row.payload_json) as PlatformEventEnvelope;
  } catch (error) {
    await markExternalEventRetry({
      eventId: row.event_id,
      status: 'accepted',
      attemptCount: row.attempt_count,
      error: error instanceof Error ? error.message : String(error),
      response: { targetJid: row.target_jid },
    });
    return;
  }
  if (!row.target_jid) return;
  try {
    const deliveryResult = await sendExternalDelivery(
      ctx,
      row.target_jid,
      buildExternalPlatformDelivery(envelope),
    );
    const deliveryMetadata = externalDeliveryMetadata(
      row.target_jid,
      deliveryResult,
    );
    const deliveredAt = new Date().toISOString();
    await updateExternalEventStatus({
      eventId: row.event_id,
      status: 'delivered',
      error: null,
      response: { targetJid: row.target_jid, ...deliveryMetadata },
      attemptCount: 0,
      nextAttemptAt: deliveredAt,
      deliveredAt,
    });
    await completeExternalDeliveryCallback({
      eventId: row.event_id,
      platformStatus: 'delivered',
      deliveredAt,
      response: { targetJid: row.target_jid, ...deliveryMetadata },
      ...deliveryMetadata,
    });
  } catch (error) {
    await markExternalEventRetry({
      eventId: row.event_id,
      status: 'accepted',
      attemptCount: row.attempt_count,
      error: error instanceof Error ? error.message : String(error),
      response: { targetJid: row.target_jid },
    });
  }
}

export function resolveExternalDeliveryRetryDelayMs(
  attemptCount: number,
): number {
  return Math.min(
    DELIVERY_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount),
    DELIVERY_RETRY_MAX_DELAY_MS,
  );
}

function resolveTargetJid(envelope: PlatformEventEnvelope): string | null {
  const target = envelope.target ?? readRecord(envelope.payload.target);
  const raw =
    readOptionalString(target?.jid) ??
    readOptionalString(target?.teamsChannelId) ??
    readOptionalString(target?.conversationId) ??
    readOptionalString(target?.channelId) ??
    readOptionalString(envelope.payload.conversationId) ??
    readOptionalString(envelope.payload.channelId);
  if (raw) return normalizeTeamsJid(raw);
  return null;
}

function resolveExternalThreadId(envelope: PlatformEventEnvelope): string | null {
  return (
    readOptionalString(envelope.payload.threadId) ??
    readOptionalString(envelope.payload.replyToId) ??
    readOptionalString(envelope.payload.messageId)
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTeamsJid(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith('teams:') ? value : `teams:${value}`;
}

function externalDeliveryMetadata(
  targetJid: string,
  result: MessageDeliveryResult | void,
): { teamsMessageId?: string; conversationId?: string } {
  return {
    ...firstExternalMessageId(result),
    ...teamsConversationIdFromTargetJid(targetJid),
  };
}

function firstExternalMessageId(result: MessageDeliveryResult | void): {
  teamsMessageId?: string;
} {
  if (!result) return {};
  if (
    typeof result.externalMessageId === 'string' &&
    result.externalMessageId.trim()
  ) {
    return { teamsMessageId: result.externalMessageId.trim() };
  }
  const first = result.externalMessageIds?.find(
    (value) => typeof value === 'string' && value.trim(),
  );
  return first ? { teamsMessageId: first.trim() } : {};
}

function teamsConversationIdFromTargetJid(targetJid: string): {
  conversationId?: string;
} {
  if (!targetJid.startsWith('teams:')) return {};
  const conversationId = targetJid.slice('teams:'.length).trim();
  return conversationId ? { conversationId } : {};
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  return raw.trim();
}
