import { createHash, createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { createIpcResponseSigningKeyPair } from '../infrastructure/ipc/response-signing.js';
import { MYCLAW_IPC_AUTH_SECRET } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { normalizeMemoryIpcActions } from '../shared/memory-ipc-actions.js';

const IPC_AUTH_SECRET =
  MYCLAW_IPC_AUTH_SECRET ||
  (() => {
    const generated = randomBytes(32).toString('hex');
    logger.warn(
      'MYCLAW_IPC_AUTH_SECRET not set; using ephemeral secret (IPC tokens will not survive restarts)',
    );
    return generated;
  })();

function authScope(workspaceKey: string, threadId?: string | null): string {
  const normalizedThreadId = threadId?.trim();
  return normalizedThreadId
    ? `${workspaceKey}\0thread\0${normalizedThreadId}`
    : workspaceKey;
}

function normalizedThreadId(threadId?: string | null): string {
  return threadId?.trim() || '';
}

const responseSigningKeys = new Map<
  string,
  {
    workspaceKey: string;
    threadId: string;
    publicKeyPem: string;
    privateKeyPem: string;
  }
>();

export function responseSigningKeyId(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('base64url');
}

export function computeIpcAuthToken(
  workspaceKey: string,
  threadId?: string | null,
): string {
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(authScope(workspaceKey, threadId))
    .digest('hex');
}

export function computeBrowserIpcAuthToken(
  workspaceKey: string,
  chatJid: string,
  threadId?: string | null,
): string {
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(`browser\0${authScope(workspaceKey, threadId)}\0chat\0${chatJid}`)
    .digest('hex');
}

export function computeMemoryIpcAuthToken(
  workspaceKey: string,
  input: {
    chatJid?: string | null;
    userId?: string | null;
    defaultScope?: 'user' | 'group' | null;
    threadId?: string | null;
    allowedActions?: readonly string[] | null;
  },
): string {
  const normalizedChatJid = input.chatJid?.trim() || '';
  const normalizedUserId = input.userId?.trim() || '';
  const normalizedDefaultScope = input.defaultScope || 'group';
  const normalizedAllowedActions = normalizeMemoryIpcActions(
    input.allowedActions ?? undefined,
  ).join(',');
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(
      `memory\0${authScope(workspaceKey, input.threadId)}\0chat\0${normalizedChatJid}\0user\0${normalizedUserId}\0scope\0${normalizedDefaultScope}\0actions\0${normalizedAllowedActions}`,
    )
    .digest('hex');
}

export function validateIpcAuthToken(
  workspaceKey: string,
  candidateToken: string,
  threadId?: string | null,
): boolean {
  if (!candidateToken) return false;
  const expected = computeIpcAuthToken(workspaceKey, threadId);
  if (candidateToken.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidateToken), Buffer.from(expected));
}

export function createIpcAuthEnvelope(
  workspaceKey: string,
  threadId?: string | null,
): {
  authToken: string;
  responseVerifyKey: string;
  responseKeyId: string;
} {
  const keys = createIpcResponseSigningKeyPair();
  const responseKeyId = responseSigningKeyId(keys.publicKeyPem);
  responseSigningKeys.set(responseKeyId, {
    workspaceKey,
    threadId: normalizedThreadId(threadId),
    ...keys,
  });
  return {
    authToken: computeIpcAuthToken(workspaceKey, threadId),
    responseVerifyKey: keys.publicKeyPem,
    responseKeyId,
  };
}

export function getIpcResponseSigningPrivateKey(
  workspaceKey: string,
  threadId?: string | null,
  responseKeyId?: string | null,
): string | undefined {
  const keyId = responseKeyId?.trim();
  if (!keyId) return undefined;
  const keys = responseSigningKeys.get(keyId);
  if (!keys) return undefined;
  if (keys.workspaceKey !== workspaceKey) return undefined;
  if (keys.threadId !== normalizedThreadId(threadId)) return undefined;
  return keys.privateKeyPem;
}

export function revokeIpcResponseSigningKey(
  responseKeyId: string | undefined,
  workspaceKey: string,
  threadId?: string | null,
): boolean {
  const keyId = responseKeyId?.trim();
  if (!keyId) return false;
  const keys = responseSigningKeys.get(keyId);
  if (!keys) return false;
  if (keys.workspaceKey !== workspaceKey) return false;
  if (keys.threadId !== normalizedThreadId(threadId)) return false;
  return responseSigningKeys.delete(keyId);
}
