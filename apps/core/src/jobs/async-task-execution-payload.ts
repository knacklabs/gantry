import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type {
  AsyncCommandLaunchControl,
  StartAsyncCommandTaskInput,
} from './async-command-task-service.js';
import type { StartDelegatedAgentTaskInput } from './async-delegated-agent-task.js';

const PAYLOAD_KEY = 'executionPayload';
const PAYLOAD_PREFIX = 'gatask:v1';
const KEY_ENV = 'SECRET_ENCRYPTION_KEY';
const KEYRING_ENV = 'SECRET_ENCRYPTION_KEYRING_JSON';

export function withEncryptedAsyncTaskPayload(
  privateCorrelationJson: Record<string, unknown>,
  input: { appId: string; taskId: string; payload: unknown },
): Record<string, unknown> {
  return {
    ...privateCorrelationJson,
    [PAYLOAD_KEY]: encryptPayload(JSON.stringify(input.payload), input),
  };
}

export function asyncCommandPrivateCorrelation(input: {
  appId: string;
  taskId: string;
  command: string;
  launchControl: AsyncCommandLaunchControl;
  taskInput: Pick<
    StartAsyncCommandTaskInput,
    | 'allowedNetworkHosts'
    | 'cwd'
    | 'egressProxyUrl'
    | 'parentTaskId'
    | 'providerAccountId'
    | 'protectedReadPaths'
    | 'protectedWritePaths'
    | 'resourceLimits'
  >;
}): Record<string, unknown> {
  const base = {
    cwd: input.taskInput.cwd ?? null,
    parentTaskId: input.taskInput.parentTaskId ?? null,
    providerAccountId: input.taskInput.providerAccountId ?? null,
    launch: input.launchControl,
  };
  return withEncryptedAsyncTaskPayload(base, {
    appId: input.appId,
    taskId: input.taskId,
    payload: {
      command: input.command,
      input: {
        cwd: input.taskInput.cwd,
        protectedReadPaths: input.taskInput.protectedReadPaths,
        protectedWritePaths: input.taskInput.protectedWritePaths,
        allowedNetworkHosts: input.taskInput.allowedNetworkHosts,
        egressProxyUrl: input.taskInput.egressProxyUrl,
        resourceLimits: input.taskInput.resourceLimits,
      },
      launchControl: input.launchControl,
    },
  });
}

export function asyncMcpPrivateCorrelation(input: {
  appId: string;
  taskId: string;
  parentTaskId?: string | null;
  providerAccountId?: string | null;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Record<string, unknown> {
  const base = {
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    providerAccountId: input.providerAccountId ?? null,
    progress: {
      phase: 'queued',
      lastProgress: 'MCP tool queued.',
      lastToolSummary: `${input.serverName}.${input.toolName}`,
    },
  };
  return withEncryptedAsyncTaskPayload(base, {
    appId: input.appId,
    taskId: input.taskId,
    payload: {
      serverName: input.serverName,
      toolName: input.toolName,
      arguments: input.arguments,
    },
  });
}

export function asyncDelegatedPrivateCorrelation(input: {
  appId: string;
  taskId: string;
  taskInput: Pick<
    StartDelegatedAgentTaskInput,
    | 'context'
    | 'expectedOutput'
    | 'objective'
    | 'providerAccountId'
    | 'targetAgentId'
    | 'workspaceFolder'
  >;
}): Record<string, unknown> {
  const base = {
    providerAccountId: input.taskInput.providerAccountId ?? null,
    workspaceFolder: input.taskInput.workspaceFolder,
    targetAgentId: input.taskInput.targetAgentId ?? null,
    steering: [],
    progress: { phase: 'queued' },
  };
  return withEncryptedAsyncTaskPayload(base, {
    appId: input.appId,
    taskId: input.taskId,
    payload: {
      objective: input.taskInput.objective,
      context: input.taskInput.context,
      expectedOutput: input.taskInput.expectedOutput,
      providerAccountId: input.taskInput.providerAccountId,
      targetAgentId: input.taskInput.targetAgentId,
      workspaceFolder: input.taskInput.workspaceFolder,
    },
  });
}

export function readEncryptedAsyncTaskPayload<T>(task: {
  appId: string;
  id: string;
  privateCorrelationJson: Record<string, unknown>;
}): T | null {
  const encrypted = task.privateCorrelationJson[PAYLOAD_KEY];
  if (typeof encrypted !== 'string') return null;
  try {
    return JSON.parse(decryptPayload(encrypted, task)) as T;
  } catch (err) {
    if (
      err instanceof AsyncTaskPayloadCryptoConfigurationError ||
      err instanceof AsyncTaskPayloadCryptoIntegrityError ||
      err instanceof SyntaxError
    ) {
      return null;
    }
    throw err;
  }
}

export class AsyncTaskPayloadCryptoConfigurationError extends Error {}
class AsyncTaskPayloadCryptoIntegrityError extends Error {}

function encryptPayload(
  value: string,
  input: { appId: string; taskId: string },
): string {
  const { key, keyId } = payloadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(payloadAad(input));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PAYLOAD_PREFIX,
    keyId,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function decryptPayload(
  stored: string,
  input: { appId: string; id: string },
): string {
  if (!stored.startsWith(PAYLOAD_PREFIX)) {
    throw new AsyncTaskPayloadCryptoIntegrityError('bad async task payload');
  }
  const [prefix, version, keyId, ivRaw, tagRaw, ciphertextRaw, extra] =
    stored.split(':');
  const key = payloadKeyById(keyId);
  if (
    prefix !== 'gatask' ||
    version !== 'v1' ||
    !ivRaw ||
    !tagRaw ||
    !ciphertextRaw ||
    extra !== undefined
  ) {
    throw new AsyncTaskPayloadCryptoIntegrityError('bad async task payload');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAAD(payloadAad({ appId: input.appId, taskId: input.id }));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function payloadKey(): { key: Buffer; keyId: string } {
  const keyring = process.env[KEYRING_ENV]?.trim();
  if (keyring) {
    const parsed = parsePayloadKeyring(keyring);
    const key = parsed.keys.get(parsed.activeKeyId);
    if (!key) {
      throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
    }
    return { key, keyId: parsed.activeKeyId };
  }
  const key = parsePayloadKey(process.env[KEY_ENV]?.trim() ?? '');
  return { key, keyId: payloadKeyId(key) };
}

function payloadKeyById(keyId: string): Buffer {
  const keyring = process.env[KEYRING_ENV]?.trim();
  if (keyring) {
    const parsed = parsePayloadKeyring(keyring);
    const key = parsed.keys.get(keyId);
    if (!key) {
      throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
    }
    return key;
  }
  const key = parsePayloadKey(process.env[KEY_ENV]?.trim() ?? '');
  if (payloadKeyId(key) !== keyId) {
    throw new AsyncTaskPayloadCryptoIntegrityError('bad async task payload');
  }
  return key;
}

function parsePayloadKey(raw: string): Buffer {
  const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new AsyncTaskPayloadCryptoConfigurationError('bad payload key');
  }
  return key;
}

function parsePayloadKeyring(raw: string): {
  activeKeyId: string;
  keys: Map<string, Buffer>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { active?: unknown }).active !== 'string' ||
    !(parsed as { active: string }).active.trim() ||
    !(parsed as { keys?: unknown }).keys ||
    typeof (parsed as { keys?: unknown }).keys !== 'object' ||
    Array.isArray((parsed as { keys?: unknown }).keys)
  ) {
    throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
  }
  const activeKeyId = (parsed as { active: string }).active;
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(
    (parsed as { keys: Record<string, unknown> }).keys,
  )) {
    if (!id.trim() || typeof encoded !== 'string') {
      throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
    }
    keys.set(id, parsePayloadKey(encoded));
  }
  if (!keys.has(activeKeyId)) {
    throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
  }
  return { activeKeyId, keys };
}

function payloadKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function payloadAad(input: { appId: string; taskId: string }): Buffer {
  return Buffer.from(`async-task:${input.appId}:${input.taskId}`, 'utf8');
}
