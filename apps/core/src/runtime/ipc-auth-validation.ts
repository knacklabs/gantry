import {
  IPC_REQUEST_MAX_AGE_MS,
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '../infrastructure/ipc/request-signing.js';
import { nowMs } from '../infrastructure/time/datetime.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import {
  normalizeMemoryIpcActions,
  type MyClawMemoryIpcAction,
} from '../shared/memory-ipc-actions.js';
import {
  computeBrowserIpcAuthToken,
  computeIpcAuthToken,
  computeMemoryIpcAuthToken,
} from './ipc-auth.js';

interface IpcThreadBinding {
  authThreadId?: string;
  payloadThreadId?: string | null;
  responseKeyId?: string;
}

interface IpcBrowserBinding extends IpcThreadBinding {
  chatJid: string;
}

interface IpcMemoryBinding extends IpcThreadBinding {
  chatJid?: string;
  userId?: string;
  defaultScope?: 'user' | 'group';
  allowedActions: readonly MyClawMemoryIpcAction[];
}

const consumedIpcRequestIds = new Map<string, number>();

function readThreadIdField(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 255, allowEmpty: true });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 255 characters`);
  }
  return parsed;
}

function readPayloadThreadIdField(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === null) return null;
  return readThreadIdField(value, label);
}

function readResponseKeyIdField(
  value: unknown,
  label: string,
): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 128 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 128 characters`);
  }
  return parsed;
}

function readTrustedThreadBinding(
  raw: Record<string, unknown>,
  label: string,
): IpcThreadBinding {
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const hasContextThreadId =
    !!context && Object.prototype.hasOwnProperty.call(context, 'threadId');
  const hasPayloadThreadId = Object.prototype.hasOwnProperty.call(
    raw,
    'threadId',
  );
  const contextThreadId = hasContextThreadId
    ? readThreadIdField(context?.threadId, `${label} context.threadId`)
    : undefined;
  const payloadThreadId = hasPayloadThreadId
    ? readPayloadThreadIdField(raw.threadId, `${label} threadId`)
    : undefined;

  if (
    hasContextThreadId &&
    hasPayloadThreadId &&
    payloadThreadId !== null &&
    contextThreadId !== payloadThreadId
  ) {
    throw new Error(`${label} threadId mismatch`);
  }

  const trustedThreadId = hasContextThreadId
    ? contextThreadId
    : payloadThreadId;
  const responseKeyId =
    context && Object.prototype.hasOwnProperty.call(context, 'responseKeyId')
      ? readResponseKeyIdField(context.responseKeyId, `${label} responseKeyId`)
      : undefined;
  return {
    authThreadId:
      typeof trustedThreadId === 'string' && trustedThreadId
        ? trustedThreadId
        : undefined,
    ...(hasPayloadThreadId ? { payloadThreadId } : {}),
    ...(responseKeyId ? { responseKeyId } : {}),
  };
}

function pruneConsumedIpcRequestIds(): void {
  const now = nowMs();
  for (const [key, expiresAt] of consumedIpcRequestIds) {
    if (expiresAt <= now) {
      consumedIpcRequestIds.delete(key);
    }
  }
}

export function clearConsumedIpcRequestIds(): void {
  consumedIpcRequestIds.clear();
}

export function validateIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
): IpcThreadBinding {
  const binding = readTrustedThreadBinding(raw, label);
  const signature = toTrimmedString(raw.signature, { maxLen: 512 }) || '';
  const payload = { ...raw };
  delete payload.signature;
  delete payload.authToken;
  const requestSigningKey = computeIpcAuthToken(
    sourceAgentFolder,
    binding.authThreadId,
  );
  if (!verifyIpcRequestPayload(requestSigningKey, payload, signature)) {
    throw new Error(`Invalid ${label} signature`);
  }
  const freshness = validateIpcRequestFreshness(payload);
  if (!freshness.ok) {
    throw new Error(`Invalid ${label} freshness: ${freshness.reason}`);
  }
  const requestId = toTrimmedString(payload.requestId, { maxLen: 128 });
  if (requestId) {
    pruneConsumedIpcRequestIds();
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:${requestId}`;
    if (consumedIpcRequestIds.has(replayKey)) {
      throw new Error(`Invalid ${label} replay`);
    }
    consumedIpcRequestIds.set(replayKey, nowMs() + IPC_REQUEST_MAX_AGE_MS);
  }
  return binding;
}

export function validateBrowserIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
): IpcBrowserBinding {
  const binding = readTrustedThreadBinding(raw, label);
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const chatJid = toTrimmedString(context?.chatJid, { maxLen: 255 });
  if (!chatJid) {
    throw new Error(`${label} context.chatJid is required`);
  }
  const signature = toTrimmedString(raw.signature, { maxLen: 512 }) || '';
  const payload = { ...raw };
  delete payload.signature;
  delete payload.authToken;
  const requestSigningKey = computeBrowserIpcAuthToken(
    sourceAgentFolder,
    chatJid,
    binding.authThreadId,
  );
  if (!verifyIpcRequestPayload(requestSigningKey, payload, signature)) {
    throw new Error(`Invalid ${label} signature`);
  }
  const freshness = validateIpcRequestFreshness(payload);
  if (!freshness.ok) {
    throw new Error(`Invalid ${label} freshness: ${freshness.reason}`);
  }
  const requestId = toTrimmedString(payload.requestId, { maxLen: 128 });
  if (requestId) {
    pruneConsumedIpcRequestIds();
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:${chatJid}:${requestId}`;
    if (consumedIpcRequestIds.has(replayKey)) {
      throw new Error(`Invalid ${label} replay`);
    }
    consumedIpcRequestIds.set(replayKey, nowMs() + IPC_REQUEST_MAX_AGE_MS);
  }
  return { ...binding, chatJid };
}

export function validateMemoryIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
): IpcMemoryBinding {
  const binding = readTrustedThreadBinding(raw, label);
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const chatJid = toTrimmedString(context?.chatJid, { maxLen: 255 });
  const userId = toTrimmedString(context?.userId, { maxLen: 255 });
  const defaultScopeRaw = toTrimmedString(context?.defaultScope, {
    maxLen: 16,
  });
  const defaultScope =
    defaultScopeRaw === 'user' || defaultScopeRaw === 'group'
      ? defaultScopeRaw
      : undefined;
  const allowedActions = normalizeMemoryIpcActions(
    Array.isArray(context?.allowedActions)
      ? context.allowedActions.filter(
          (action): action is string => typeof action === 'string',
        )
      : undefined,
  );
  const signature = toTrimmedString(raw.signature, { maxLen: 512 }) || '';
  const payload = { ...raw };
  delete payload.signature;
  delete payload.authToken;
  const requestSigningKey = computeMemoryIpcAuthToken(sourceAgentFolder, {
    ...(chatJid ? { chatJid } : {}),
    ...(userId ? { userId } : {}),
    defaultScope: defaultScope || 'group',
    threadId: binding.authThreadId,
    allowedActions,
  });
  if (!verifyIpcRequestPayload(requestSigningKey, payload, signature)) {
    throw new Error(`Invalid ${label} signature`);
  }
  const freshness = validateIpcRequestFreshness(payload);
  if (!freshness.ok) {
    throw new Error(`Invalid ${label} freshness: ${freshness.reason}`);
  }
  const requestId = toTrimmedString(payload.requestId, { maxLen: 128 });
  if (requestId) {
    pruneConsumedIpcRequestIds();
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:memory:${userId || ''}:${defaultScope || 'group'}:${requestId}`;
    if (consumedIpcRequestIds.has(replayKey)) {
      throw new Error(`Invalid ${label} replay`);
    }
    consumedIpcRequestIds.set(replayKey, nowMs() + IPC_REQUEST_MAX_AGE_MS);
  }
  return {
    ...binding,
    ...(chatJid ? { chatJid } : {}),
    ...(userId ? { userId } : {}),
    ...(defaultScope ? { defaultScope } : {}),
    allowedActions,
  };
}
