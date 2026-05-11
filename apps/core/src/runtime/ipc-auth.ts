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

function authScope(
  workspaceKey: string,
  threadId?: string | null,
  scope?: { appId?: string | null; agentId?: string | null },
): string {
  const normalizedThreadId = threadId?.trim();
  const threadScope = normalizedThreadId
    ? `${workspaceKey}\0thread\0${normalizedThreadId}`
    : workspaceKey;
  const normalizedAppId = scope?.appId?.trim();
  const normalizedAgentId = scope?.agentId?.trim();
  if (!normalizedAppId && !normalizedAgentId) return threadScope;
  return `${threadScope}\0app\0${normalizedAppId || ''}\0agent\0${normalizedAgentId || ''}`;
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
const browserIpcAuthorizations = new Map<string, number>();

export function responseSigningKeyId(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('base64url');
}

export function computeIpcAuthToken(
  workspaceKey: string,
  threadId?: string | null,
  scope?: { appId?: string | null; agentId?: string | null },
): string {
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(authScope(workspaceKey, threadId, scope))
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

function browserIpcAuthorizationKey(input: {
  workspaceKey: string;
  chatJid: string;
  threadId?: string | null;
}): string {
  return `${input.workspaceKey}\0${normalizedThreadId(input.threadId)}\0${input.chatJid}`;
}

export function registerBrowserIpcAuthorization(input: {
  workspaceKey: string;
  chatJid: string;
  threadId?: string | null;
}): void {
  const key = browserIpcAuthorizationKey(input);
  browserIpcAuthorizations.set(
    key,
    (browserIpcAuthorizations.get(key) ?? 0) + 1,
  );
}

export function revokeBrowserIpcAuthorization(input: {
  workspaceKey: string;
  chatJid: string;
  threadId?: string | null;
}): void {
  const key = browserIpcAuthorizationKey(input);
  const count = browserIpcAuthorizations.get(key) ?? 0;
  if (count <= 1) {
    browserIpcAuthorizations.delete(key);
    return;
  }
  browserIpcAuthorizations.set(key, count - 1);
}

export function isBrowserIpcAuthorized(input: {
  workspaceKey: string;
  chatJid: string;
  threadId?: string | null;
}): boolean {
  return (
    (browserIpcAuthorizations.get(browserIpcAuthorizationKey(input)) ?? 0) > 0
  );
}

export function computeMemoryIpcAuthToken(
  workspaceKey: string,
  input: {
    chatJid?: string | null;
    userId?: string | null;
    defaultScope?: 'user' | 'group' | null;
    threadId?: string | null;
    allowedActions?: readonly string[] | null;
    reviewerIsControlApprover?: boolean | null;
  },
): string {
  const normalizedChatJid = input.chatJid?.trim() || '';
  const normalizedUserId = input.userId?.trim() || '';
  const normalizedDefaultScope = input.defaultScope || 'group';
  const normalizedAllowedActions = normalizeMemoryIpcActions(
    input.allowedActions ?? undefined,
  ).join(',');
  const reviewerScope = input.reviewerIsControlApprover ? 'approver' : 'user';
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(
      `memory\0${authScope(workspaceKey, input.threadId)}\0chat\0${normalizedChatJid}\0user\0${normalizedUserId}\0scope\0${normalizedDefaultScope}\0actions\0${normalizedAllowedActions}\0reviewer\0${reviewerScope}`,
    )
    .digest('hex');
}

export function validateIpcAuthToken(
  workspaceKey: string,
  candidateToken: string,
  threadId?: string | null,
  scope?: { appId?: string | null; agentId?: string | null },
): boolean {
  if (!candidateToken) return false;
  const expected = computeIpcAuthToken(workspaceKey, threadId, scope);
  if (candidateToken.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidateToken), Buffer.from(expected));
}

export function createIpcAuthEnvelope(
  workspaceKey: string,
  threadId?: string | null,
  scope?: { appId?: string | null; agentId?: string | null },
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
    authToken: computeIpcAuthToken(workspaceKey, threadId, scope),
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
