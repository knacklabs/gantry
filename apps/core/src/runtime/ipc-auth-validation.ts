import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
import {
  IPC_REQUEST_MAX_AGE_MS,
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '../infrastructure/ipc/request-signing.js';
import { ipcInteractionAuthValidationOptions } from '../shared/ipc-interaction-lifetime.js';
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
  providerAccountId?: string;
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

function readProviderAccountIdField(
  value: unknown,
  label: string,
): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 255 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 255 characters`);
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
  const contextProviderAccountId =
    context &&
    Object.prototype.hasOwnProperty.call(context, 'providerAccountId')
      ? readProviderAccountIdField(
          context.providerAccountId,
          `${label} context.providerAccountId`,
        )
      : undefined;
  const payloadProviderAccountId = Object.prototype.hasOwnProperty.call(
    raw,
    'providerAccountId',
  )
    ? readProviderAccountIdField(
        raw.providerAccountId,
        `${label} providerAccountId`,
      )
    : undefined;
  if (
    contextProviderAccountId &&
    payloadProviderAccountId &&
    contextProviderAccountId !== payloadProviderAccountId
  ) {
    throw new Error(`${label} providerAccountId mismatch`);
  }
  return {
    appId: contextAppId ?? payloadAppId,
    agentId: contextAgentId ?? payloadAgentId,
    providerAccountId: contextProviderAccountId ?? payloadProviderAccountId,
    authThreadId:
      typeof trustedThreadId === 'string' && trustedThreadId
        ? trustedThreadId
        : undefined,
    ...(hasPayloadThreadId ? { payloadThreadId } : {}),
    ...(responseKeyId ? { responseKeyId } : {}),
  };
}

const REPLAY_MARKER_SWEEP_INTERVAL_MS = 1_000;
const REPLAY_MARKER_SWEEP_BATCH_SIZE = 128;
const REPLAY_MARKER_SWEEP_TIME_BUDGET_MS = 100;
const REPLAY_MARKER_SWEEP_GRACE_MS = IPC_REQUEST_MAX_AGE_MS * 2;
let consumedIpcRequestIdSweep: IterableIterator<[string, number]> | undefined;
let consumedIpcRequestIdSweepInProgress = false;
let replayMarkerSweepDir: fs.Dir | undefined;
let replayMarkerSweepGeneration = 0;
let replayMarkerSweepInProgress = false;
let replayMarkerSweepTimer: ReturnType<typeof setInterval> | undefined;

function replayMarkerSweepWithinBudget(startedAt: bigint): boolean {
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return elapsedMs < REPLAY_MARKER_SWEEP_TIME_BUDGET_MS;
}

function yieldReplayMarkerSweep(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function pruneConsumedIpcRequestIds(): Promise<void> {
  if (consumedIpcRequestIdSweepInProgress) return;
  consumedIpcRequestIdSweepInProgress = true;
  const generation = replayMarkerSweepGeneration;
  const startedAt = process.hrtime.bigint();
  const now = nowMs();
  try {
    while (generation === replayMarkerSweepGeneration) {
      let foundExpired = false;
      consumedIpcRequestIdSweep ??= consumedIpcRequestIds.entries();
      for (
        let inspected = 0;
        inspected < REPLAY_MARKER_SWEEP_BATCH_SIZE;
        inspected += 1
      ) {
        const entry = consumedIpcRequestIdSweep.next();
        if (entry.done) {
          consumedIpcRequestIdSweep = undefined;
          return;
        }
        const [key, expiresAt] = entry.value;
        if (expiresAt <= now) {
          consumedIpcRequestIds.delete(key);
          foundExpired = true;
        }
      }
      if (!foundExpired || !replayMarkerSweepWithinBudget(startedAt)) return;
      await yieldReplayMarkerSweep();
    }
  } finally {
    consumedIpcRequestIdSweepInProgress = false;
  }
}

async function closeReplayMarkerSweepDir(dir: fs.Dir): Promise<void> {
  if (replayMarkerSweepDir === dir) replayMarkerSweepDir = undefined;
  try {
    await dir.close();
  } catch {
    // The lifecycle stop path may already have closed the cursor.
  }
}

async function readReplayMarkerExpiry(
  markerPath: string,
): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(markerPath, 'utf-8'),
    ) as { expiresAtMs?: unknown };
    return typeof parsed.expiresAtMs === 'number' &&
      Number.isFinite(parsed.expiresAtMs)
      ? parsed.expiresAtMs
      : undefined;
  } catch {
    return undefined;
  }
}

async function reclaimMalformedReplayMarker(
  markerPath: string,
  graceExpiredBefore: number,
): Promise<boolean> {
  try {
    const markerStat = await fs.promises.stat(markerPath);
    if (markerStat.mtimeMs > graceExpiredBefore) return false;
    const confirmedStat = await fs.promises.stat(markerPath);
    if (confirmedStat.mtimeMs > graceExpiredBefore) return false;
    await fs.promises.rm(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function reclaimGraceExpiredReplayMarker(
  markerPath: string,
  graceExpiredBefore: number,
): Promise<boolean> {
  const expiresAtMs = await readReplayMarkerExpiry(markerPath);
  if (expiresAtMs === undefined) {
    return reclaimMalformedReplayMarker(markerPath, graceExpiredBefore);
  }
  if (expiresAtMs > graceExpiredBefore) return false;

  const confirmedExpiresAtMs = await readReplayMarkerExpiry(markerPath);
  if (
    confirmedExpiresAtMs === undefined ||
    confirmedExpiresAtMs > graceExpiredBefore
  ) {
    return false;
  }
  try {
    await fs.promises.rm(markerPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function pruneReplayMarkersOnDisk(): Promise<void> {
  if (replayMarkerSweepInProgress) return;
  replayMarkerSweepInProgress = true;
  const generation = replayMarkerSweepGeneration;
  const startedAt = process.hrtime.bigint();
  let dir = replayMarkerSweepDir;
  try {
    dir ??= await fs.promises.opendir(replayStoreDir(), {
      bufferSize: REPLAY_MARKER_SWEEP_BATCH_SIZE,
    });
    if (generation !== replayMarkerSweepGeneration) {
      await closeReplayMarkerSweepDir(dir);
      return;
    }
    replayMarkerSweepDir = dir;
    const now = nowMs();
    const graceExpiredBefore = now - REPLAY_MARKER_SWEEP_GRACE_MS;
    // Decision 0027 permits multiple live workers to share DATA_DIR. Freshness
    // validation runs before reservation, so markers remain sweep-untouchable
    // for twice that same freshness window after expiry. Once past this derived
    // grace, the represented request cannot legitimately reach reservation in
    // any process, and deleting its hash-addressed marker cannot race a rewrite.
    while (generation === replayMarkerSweepGeneration) {
      const markerPaths: string[] = [];
      let completedPass = false;
      for (
        let inspected = 0;
        inspected < REPLAY_MARKER_SWEEP_BATCH_SIZE;
        inspected += 1
      ) {
        const entry = await dir.read();
        if (generation !== replayMarkerSweepGeneration) {
          await closeReplayMarkerSweepDir(dir);
          return;
        }
        if (!entry) {
          completedPass = true;
          break;
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        markerPaths.push(path.join(replayStoreDir(), entry.name));
      }
      const graceExpired = await Promise.allSettled(
        markerPaths.map((markerPath) =>
          reclaimGraceExpiredReplayMarker(markerPath, graceExpiredBefore),
        ),
      );
      if (generation !== replayMarkerSweepGeneration) {
        await closeReplayMarkerSweepDir(dir);
        return;
      }
      if (completedPass) {
        await closeReplayMarkerSweepDir(dir);
        return;
      }
      if (
        !graceExpired.some(
          (result) => result.status === 'fulfilled' && result.value,
        ) ||
        !replayMarkerSweepWithinBudget(startedAt)
      ) {
        return;
      }
      await yieldReplayMarkerSweep();
    }
  } catch {
    if (dir) await closeReplayMarkerSweepDir(dir);
  } finally {
    replayMarkerSweepInProgress = false;
  }
}

function ensureReplayMarkerSweepTimer(): void {
  if (replayMarkerSweepTimer) return;
  replayMarkerSweepTimer = setInterval(() => {
    void pruneConsumedIpcRequestIds();
    void pruneReplayMarkersOnDisk();
  }, REPLAY_MARKER_SWEEP_INTERVAL_MS);
  replayMarkerSweepTimer.unref?.();
}

function stopReplayMarkerSweepTimer(): void {
  replayMarkerSweepGeneration += 1;
  if (replayMarkerSweepTimer) {
    clearInterval(replayMarkerSweepTimer);
    replayMarkerSweepTimer = undefined;
  }
  consumedIpcRequestIdSweep = undefined;
  if (replayMarkerSweepDir) {
    const dir = replayMarkerSweepDir;
    replayMarkerSweepDir = undefined;
    void closeReplayMarkerSweepDir(dir);
  }
}

function reserveIpcReplayMarker(key: string, expiresAtMs: number): boolean {
  const now = nowMs();
  const consumedUntil = consumedIpcRequestIds.get(key);
  if (consumedUntil !== undefined) {
    if (consumedUntil > now) return false;
    consumedIpcRequestIds.delete(key);
  }
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
        // Legitimately fresh IPC requests use a unique UUID-backed request id;
        // stale requests are rejected before reservation. Replacing an existing
        // id therefore serves no valid traffic and only creates cross-worker
        // delete/recreate races. The sweeper alone makes an id reservable after
        // its derived grace, when any request bearing that id is already stale.
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
  stopReplayMarkerSweepTimer();
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
  ensureReplayMarkerSweepTimer();
  if (!reserveIpcReplayMarker(replayKey, expiresAtMs)) {
    throw new Error(`Invalid ${label} replay`);
  }
}

export function validateIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
  options?: {
    extendedAuthPurpose: 'unbounded-interaction' | 'cancellation-retention';
    extendedMaxAgeMs: number;
  },
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
  const maxAgeMs =
    options && payload.authPurpose === options.extendedAuthPurpose
      ? options.extendedMaxAgeMs
      : IPC_REQUEST_MAX_AGE_MS;
  const validationNowMs = nowMs();
  if (typeof payload.authExpiresAt === 'string') {
    const authIssuedAtMs =
      typeof payload.authIssuedAt === 'string'
        ? Date.parse(payload.authIssuedAt)
        : Number.NaN;
    const authExpiresAtMs = Date.parse(payload.authExpiresAt);
    if (
      !Number.isFinite(authIssuedAtMs) ||
      !Number.isFinite(authExpiresAtMs) ||
      authIssuedAtMs > validationNowMs ||
      authExpiresAtMs - authIssuedAtMs > maxAgeMs
    ) {
      throw new Error(`Invalid ${label} freshness: expiresAt exceeds max age`);
    }
  }
  const freshness = validateIpcRequestFreshness(
    payload,
    validationNowMs,
    maxAgeMs,
  );
  if (!freshness.ok) {
    throw new Error(`Invalid ${label} freshness: ${freshness.reason}`);
  }
  const requestId = toTrimmedString(payload.requestId, { maxLen: 128 });
  if (requestId) {
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:${requestId}`;
    reserveFreshIpcRequestId(replayKey, nowMs() + maxAgeMs, label);
  }
  return binding;
}

export function validateInteractionIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
): IpcThreadBinding {
  // Only signed interactive permission/question requests may outlive the
  // ordinary five-minute bound; cancellations use their own explicit purpose.
  return validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    label,
    ipcInteractionAuthValidationOptions(raw.permissionLane),
  );
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
    appId: binding.appId,
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
