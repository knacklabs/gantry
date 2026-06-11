import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
} from 'crypto';
import { createIpcResponseSigningKeyPair } from '../infrastructure/ipc/response-signing.js';
import { GANTRY_IPC_AUTH_SECRET } from '../config/index.js';
import { runtimeEnvValueDynamic } from '../config/env/index.js';
import {
  resolveRuntimeSecurityPosture,
  type RuntimeSecurityEnv,
} from '../shared/security-posture.js';
import { normalizeMemoryIpcActions } from '../shared/memory-ipc-actions.js';

function resolveIpcAuthSecurityEnv(): RuntimeSecurityEnv {
  return {
    NODE_ENV: runtimeEnvValueDynamic('NODE_ENV'),
    GANTRY_SECURITY_POSTURE: runtimeEnvValueDynamic('GANTRY_SECURITY_POSTURE'),
    GANTRY_RUNTIME_ENV: runtimeEnvValueDynamic('GANTRY_RUNTIME_ENV'),
    GANTRY_CONTROL_HOST: runtimeEnvValueDynamic('GANTRY_CONTROL_HOST'),
    GANTRY_CONTROL_PORT: runtimeEnvValueDynamic('GANTRY_CONTROL_PORT'),
  };
}

const IPC_AUTH_SECRET =
  GANTRY_IPC_AUTH_SECRET ||
  (() => {
    if (
      resolveRuntimeSecurityPosture(resolveIpcAuthSecurityEnv())
        .requiresProductionSecrets
    ) {
      throw new Error(
        'GANTRY_IPC_AUTH_SECRET is required in production or remote control mode.',
      );
    }
    const generated = randomBytes(32).toString('hex');
    console.warn(
      'GANTRY_IPC_AUTH_SECRET not set; using ephemeral secret (IPC tokens will not survive restarts)',
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
const RESPONSE_PRIVATE_KEY_SEAL_AAD = Buffer.from(
  'gantry:ipc-response-private-key:v1',
);

function responsePrivateKeySealKey(): Buffer {
  return createHash('sha256').update(IPC_AUTH_SECRET).digest();
}

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

export function sealIpcResponseSigningPrivateKey(
  privateKeyPem: string | undefined,
): string | undefined {
  if (!privateKeyPem) return undefined;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', responsePrivateKeySealKey(), iv);
  cipher.setAAD(RESPONSE_PRIVATE_KEY_SEAL_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(privateKeyPem, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function unsealIpcResponseSigningPrivateKey(
  sealed: string | undefined,
): string | undefined {
  if (!sealed) return undefined;
  const [version, ivB64, tagB64, ciphertextB64] = sealed.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ciphertextB64) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      responsePrivateKeySealKey(),
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAAD(RESPONSE_PRIVATE_KEY_SEAL_AAD);
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
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
