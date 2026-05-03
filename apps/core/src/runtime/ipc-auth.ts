import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { createIpcResponseSigningKeyPair } from '../infrastructure/ipc/response-signing.js';
import { MYCLAW_IPC_AUTH_SECRET } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';

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

function responseScope(workspaceKey: string, threadId?: string | null): string {
  return `response\0${authScope(workspaceKey, threadId)}`;
}

const responseSigningKeys = new Map<
  string,
  { publicKeyPem: string; privateKeyPem: string }
>();

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
    userId?: string | null;
    defaultScope?: 'user' | 'group' | null;
    threadId?: string | null;
  },
): string {
  const normalizedUserId = input.userId?.trim() || '';
  const normalizedDefaultScope = input.defaultScope || 'group';
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(
      `memory\0${authScope(workspaceKey, input.threadId)}\0user\0${normalizedUserId}\0scope\0${normalizedDefaultScope}`,
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
} {
  const scope = responseScope(workspaceKey, threadId);
  const keys = createIpcResponseSigningKeyPair();
  responseSigningKeys.set(scope, keys);
  return {
    authToken: computeIpcAuthToken(workspaceKey, threadId),
    responseVerifyKey: keys.publicKeyPem,
  };
}

export function getIpcResponseSigningPrivateKey(
  workspaceKey: string,
  threadId?: string | null,
): string | undefined {
  return responseSigningKeys.get(responseScope(workspaceKey, threadId))
    ?.privateKeyPem;
}
