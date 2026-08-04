import { createCipheriv, createDecipheriv, createHash, randomBytes, } from 'node:crypto';
const PAYLOAD_KEY = 'executionPayload';
const PAYLOAD_PREFIX = 'gatask:v1';
const KEY_ENV = 'SECRET_ENCRYPTION_KEY';
const KEYRING_ENV = 'SECRET_ENCRYPTION_KEYRING_JSON';
export function withEncryptedAsyncTaskPayload(privateCorrelationJson, input) {
    return {
        ...privateCorrelationJson,
        [PAYLOAD_KEY]: encryptPayload(JSON.stringify(input.payload), input),
    };
}
export function asyncCommandPrivateCorrelation(input) {
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
export function asyncMcpPrivateCorrelation(input) {
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
export function asyncDelegatedPrivateCorrelation(input) {
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
export function readEncryptedAsyncTaskPayload(task) {
    const encrypted = task.privateCorrelationJson[PAYLOAD_KEY];
    if (typeof encrypted !== 'string')
        return null;
    try {
        return JSON.parse(decryptPayload(encrypted, task));
    }
    catch (err) {
        if (err instanceof AsyncTaskPayloadCryptoConfigurationError ||
            err instanceof AsyncTaskPayloadCryptoIntegrityError ||
            err instanceof SyntaxError) {
            return null;
        }
        throw err;
    }
}
export class AsyncTaskPayloadCryptoConfigurationError extends Error {
}
class AsyncTaskPayloadCryptoIntegrityError extends Error {
}
function encryptPayload(value, input) {
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
function decryptPayload(stored, input) {
    if (!stored.startsWith(PAYLOAD_PREFIX)) {
        throw new AsyncTaskPayloadCryptoIntegrityError('bad async task payload');
    }
    const [prefix, version, keyId, ivRaw, tagRaw, ciphertextRaw, extra] = stored.split(':');
    const key = payloadKeyById(keyId);
    if (prefix !== 'gatask' ||
        version !== 'v1' ||
        !ivRaw ||
        !tagRaw ||
        !ciphertextRaw ||
        extra !== undefined) {
        throw new AsyncTaskPayloadCryptoIntegrityError('bad async task payload');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAAD(payloadAad({ appId: input.appId, taskId: input.id }));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
}
function payloadKey() {
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
function payloadKeyById(keyId) {
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
function parsePayloadKey(raw) {
    const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) {
        throw new AsyncTaskPayloadCryptoConfigurationError('bad payload key');
    }
    return key;
}
function parsePayloadKeyring(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
    }
    if (!parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof parsed.active !== 'string' ||
        !parsed.active.trim() ||
        !parsed.keys ||
        typeof parsed.keys !== 'object' ||
        Array.isArray(parsed.keys)) {
        throw new AsyncTaskPayloadCryptoConfigurationError('bad payload keyring');
    }
    const activeKeyId = parsed.active;
    const keys = new Map();
    for (const [id, encoded] of Object.entries(parsed.keys)) {
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
function payloadKeyId(key) {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
}
function payloadAad(input) {
    return Buffer.from(`async-task:${input.appId}:${input.taskId}`, 'utf8');
}
