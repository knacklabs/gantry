import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
import {
  IPC_REQUEST_MAX_AGE_MS,
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '../infrastructure/ipc/request-signing.js';
import { nowMs } from '../shared/time/datetime.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import {
  normalizeMemoryIpcActions,
  type GantryMemoryIpcAction,
} from '../shared/memory-ipc-actions.js';
import { ensurePrivateDirSync } from '../shared/private-fs.js';
import {
  computeBrowserIpcAuthToken,
  computeIpcAuthToken,
  computeMemoryIpcAuthToken,
} from './ipc-auth.js';

interface IpcThreadBinding {
  appId?: string;
  agentId?: string;
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
  reviewerIsControlApprover?: boolean;
  allowedActions: readonly GantryMemoryIpcAction[];
}

const consumedIpcRequestIds = new Map<string, number>();

function replayStoreDir(): string {
  return path.join(DATA_DIR, 'ipc-replay');
}

function replayMarkerPath(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex');
  return path.join(replayStoreDir(), `${digest}.json`);
}

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

function readAppIdField(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 128 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 128 characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function readAgentIdField(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 200 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 200 characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(parsed)) {
    throw new Error(`${label} is invalid`);
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
  const contextAppId =
    context && Object.prototype.hasOwnProperty.call(context, 'appId')
      ? readAppIdField(context.appId, `${label} context.appId`)
      : undefined;
  const payloadAppId = Object.prototype.hasOwnProperty.call(raw, 'appId')
    ? readAppIdField(raw.appId, `${label} appId`)
    : undefined;
  if (contextAppId && payloadAppId && contextAppId !== payloadAppId) {
    throw new Error(`${label} appId mismatch`);
  }
  const contextAgentId =
    context && Object.prototype.hasOwnProperty.call(context, 'agentId')
      ? readAgentIdField(context.agentId, `${label} context.agentId`)
      : undefined;
  const payloadAgentId = Object.prototype.hasOwnProperty.call(raw, 'agentId')
    ? readAgentIdField(raw.agentId, `${label} agentId`)
    : undefined;
  if (contextAgentId && payloadAgentId && contextAgentId !== payloadAgentId) {
    throw new Error(`${label} agentId mismatch`);
  }
  return {
    appId: contextAppId ?? payloadAppId,
    agentId: contextAgentId ?? payloadAgentId,
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
  const dir = replayStoreDir();
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const markerPath = path.join(dir, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as {
        expiresAtMs?: unknown;
      };
      const expiresAtMs =
        typeof parsed.expiresAtMs === 'number' ? parsed.expiresAtMs : 0;
      if (expiresAtMs <= now) fs.rmSync(markerPath, { force: true });
    } catch {
      fs.rmSync(markerPath, { force: true });
    }
  }
}

function reserveIpcReplayMarker(key: string, expiresAtMs: number): boolean {
  if (consumedIpcRequestIds.has(key)) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      ensurePrivateDirSync(replayStoreDir());
      fs.writeFileSync(replayMarkerPath(key), JSON.stringify({ expiresAtMs }), {
        flag: 'wx',
        mode: 0o600,
      });
      consumedIpcRequestIds.set(key, expiresAtMs);
      return true;
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: unknown }).code === 'EEXIST'
      ) {
        consumedIpcRequestIds.set(key, expiresAtMs);
        return false;
      }
      if (
        attempt === 0 &&
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: unknown }).code === 'ENOENT'
      ) {
        continue;
      }
      throw err;
    }
  }
  return false;
}

export function clearConsumedIpcRequestIds(input?: {
  durable?: boolean | 'consumed';
}): void {
  const consumedKeys = [...consumedIpcRequestIds.keys()];
  consumedIpcRequestIds.clear();
  if (input?.durable !== true && input?.durable !== 'consumed') return;
  const dir = replayStoreDir();
  if (!fs.existsSync(dir)) return;
  if (input.durable === 'consumed') {
    for (const key of consumedKeys) {
      fs.rmSync(replayMarkerPath(key), { force: true });
    }
    return;
  }
  for (const file of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, file), { force: true });
  }
}

function reserveFreshIpcRequestId(
  replayKey: string,
  expiresAtMs: number,
  label: string,
): void {
  pruneConsumedIpcRequestIds();
  if (!reserveIpcReplayMarker(replayKey, expiresAtMs)) {
    throw new Error(`Invalid ${label} replay`);
  }
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
    { appId: binding.appId, agentId: binding.agentId },
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
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:${requestId}`;
    reserveFreshIpcRequestId(
      replayKey,
      nowMs() + IPC_REQUEST_MAX_AGE_MS,
      label,
    );
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
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:${chatJid}:${requestId}`;
    reserveFreshIpcRequestId(
      replayKey,
      nowMs() + IPC_REQUEST_MAX_AGE_MS,
      label,
    );
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
  const reviewerIsControlApprover = context?.reviewerIsControlApprover === true;
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
    reviewerIsControlApprover,
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
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:memory:${userId || ''}:${defaultScope || 'group'}:${requestId}`;
    reserveFreshIpcRequestId(
      replayKey,
      nowMs() + IPC_REQUEST_MAX_AGE_MS,
      label,
    );
  }
  return {
    ...binding,
    ...(chatJid ? { chatJid } : {}),
    ...(userId ? { userId } : {}),
    ...(defaultScope ? { defaultScope } : {}),
    ...(reviewerIsControlApprover ? { reviewerIsControlApprover } : {}),
    allowedActions,
  };
}
