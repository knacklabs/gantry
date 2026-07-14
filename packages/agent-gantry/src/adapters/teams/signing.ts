import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  GantryExternalCardAction,
  GantryExternalCardActionSigningInput,
  GantryExternalCardActionVerificationInput,
  GantrySignatureInput,
  GantrySignatureVerificationInput,
  GantryWebhookSignatureVerificationInput,
} from './types.js';
import { readStringValue } from '../../shared/helpers.js';

export function signExternalEventRequest(input: GantrySignatureInput): string {
  return createHmac('sha256', input.secret)
    .update(buildExternalSignaturePayload(input))
    .digest('hex');
}

export function verifyExternalEventSignature(
  input: GantrySignatureVerificationInput,
): boolean {
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (
    !Number.isFinite(timestampMs) ||
    (toleranceMs >= 0 &&
      Math.abs((input.nowMs ?? Date.now()) - timestampMs) > toleranceMs)
  ) {
    return false;
  }
  return timingSafeHexEqual(signExternalEventRequest(input), input.signature);
}

export function verifyWebhookSignature(
  input: GantryWebhookSignatureVerificationInput,
): boolean {
  const timestampMs = Number(input.timestamp);
  const toleranceMs = input.toleranceMs ?? 5 * 60_000;
  if (
    !Number.isFinite(timestampMs) ||
    (toleranceMs >= 0 &&
      Math.abs((input.nowMs ?? Date.now()) - timestampMs) > toleranceMs)
  ) {
    return false;
  }
  const expected = createHmac('sha256', input.secret)
    .update(
      `${input.timestamp}.${input.eventId}.${input.eventType}.${input.rawBody}`,
    )
    .digest('hex');
  return timingSafeHexEqual(expected, input.signature);
}

export function signExternalCardAction(
  input: GantryExternalCardActionSigningInput & { readonly secret: string },
): {
  readonly nonce: string;
  readonly expiresAt: string;
  readonly signature: string;
  readonly signatureVersion?: 'v2';
} {
  const nonce = input.nonce ?? randomUUID();
  const expiresAt = normalizeExternalCardActionExpiresAtForSignature(
    input.expiresAt ??
      new Date((input.nowMs ?? Date.now()) + 24 * 60 * 60_000).toISOString(),
  );
  return {
    nonce,
    expiresAt,
    ...(input.signatureVersion === 'v2'
      ? { signatureVersion: 'v2' as const }
      : {}),
    signature: createHmac('sha256', input.secret)
      .update(stableCardActionPayload({ ...input, nonce, expiresAt }))
      .digest('hex'),
  };
}

export function verifyExternalCardAction(
  input: GantryExternalCardActionVerificationInput,
): boolean {
  const expiresAt = normalizeExternalCardActionExpiresAtForSignature(
    input.action.expiresAt,
  );
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs < (input.nowMs ?? Date.now())
  ) {
    return false;
  }
  const expected = signExternalCardAction({
    secret: input.secret,
    integrationId: input.action.integrationId,
    eventId: input.action.eventId,
    subjectId: input.action.subjectId,
    scopeId: input.action.scopeId,
    sourceScopeId: input.action.sourceScopeId ?? input.action.scopeId,
    sourceConversationId: input.action.sourceConversationId,
    teamsTenantId: input.action.teamsTenantId,
    actionType: input.action.actionType,
    platformOperation:
      input.action.signatureVersion === 'v2'
        ? input.action.platformOperation
        : null,
    requestId:
      input.action.signatureVersion === 'v2'
        ? input.action.requestId || null
        : null,
    signatureVersion: input.action.signatureVersion ?? null,
    nonce: input.action.nonce,
    expiresAt,
    nowMs: input.nowMs,
  }).signature;
  return timingSafeHexEqual(expected, input.action.signature);
}

export function parseExternalCardAction(
  value: unknown,
): GantryExternalCardAction | null {
  if (!value || typeof value !== 'object') return null;
  const record = unwrapExternalCardActionValue(
    value as Record<string, unknown>,
  );
  if (!record || record.action !== 'external_card_action') return null;
  const action = {
    integrationId: readStringValue(record.integrationId),
    eventId: readStringValue(record.eventId),
    subjectId: readStringValue(record.subjectId),
    scopeId: readStringValue(record.scopeId),
    sourceScopeId: readStringValue(record.sourceScopeId) || null,
    sourceConversationId: readStringValue(record.sourceConversationId),
    teamsTenantId: readStringValue(record.teamsTenantId),
    actionType: readStringValue(record.actionType),
    platformOperation: readStringValue(record.platformOperation),
    requestId: readStringValue(record.requestId) || null,
    signatureVersion:
      readStringValue(record.signatureVersion) === 'v2'
        ? ('v2' as const)
        : null,
    nonce: readStringValue(record.nonce),
    expiresAt: readStringValue(record.expiresAt),
    signature: readStringValue(record.signature),
  };
  if (
    !action.integrationId ||
    !action.eventId ||
    !action.subjectId ||
    !action.scopeId ||
    !action.sourceConversationId ||
    !action.teamsTenantId ||
    !action.actionType ||
    !action.platformOperation ||
    !action.nonce ||
    !action.expiresAt ||
    !action.signature
  ) {
    return null;
  }
  return {
    ...action,
    expiresAt: normalizeExternalCardActionExpiresAtForSignature(
      action.expiresAt,
    ),
  };
}

export const signGantryExternalEventRequest = signExternalEventRequest;
export const verifyGantryExternalEventSignature = verifyExternalEventSignature;

export function normalizeExternalCardActionExpiresAtForSignature(
  expiresAt: string,
): string {
  const parsed = Date.parse(expiresAt.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error('External card action expiration timestamp is invalid.');
  }
  return new Date(parsed).toISOString();
}

function buildExternalSignaturePayload(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly rawBody: string;
}): string {
  return [
    input.method.trim().toUpperCase(),
    input.path.trim(),
    input.timestamp.trim(),
    input.nonce.trim(),
    input.rawBody,
  ].join('\n');
}

function timingSafeHexEqual(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex);
  const right = Buffer.from(rightHex);
  return left.length === right.length && timingSafeEqual(left, right);
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

function stableCardActionPayload(input: {
  readonly integrationId: string;
  readonly eventId: string;
  readonly subjectId: string | null;
  readonly scopeId: string | null;
  readonly sourceScopeId?: string | null;
  readonly sourceConversationId: string | null;
  readonly teamsTenantId: string | null;
  readonly actionType: string;
  readonly platformOperation?: string | null;
  readonly requestId?: string | null;
  readonly signatureVersion?: 'v2' | null;
  readonly nonce: string;
  readonly expiresAt: string;
}): string {
  const payload: Record<string, unknown> = {
    integrationId: input.integrationId,
    eventId: input.eventId,
    subjectId: input.subjectId,
    scopeId: input.scopeId,
    sourceScopeId: input.sourceScopeId ?? input.scopeId,
    sourceConversationId: input.sourceConversationId,
    teamsTenantId: input.teamsTenantId,
    actionType: input.actionType,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
  };
  if (input.signatureVersion === 'v2') {
    payload.signatureVersion = 'v2';
    payload.platformOperation = input.platformOperation ?? null;
    payload.requestId = input.requestId ?? null;
  }
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort()));
}
