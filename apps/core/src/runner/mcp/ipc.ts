import fs from 'fs';
import path from 'path';
import { BrowserIpcAction, MemoryIpcAction } from '@myclaw/contracts';
import {
  nowMs,
  nowMs as currentTimeMs,
  sleep,
} from '../../shared/time/datetime.js';
import {
  formatMemoryTimeoutError,
  getMemoryActionTimeoutMs,
} from '../memory-timeouts.js';
import {
  BROWSER_REQUESTS_DIR,
  BROWSER_RESPONSES_DIR,
  BROWSER_IPC_AUTH_TOKEN,
  IPC_AUTH_TOKEN,
  IPC_RESPONSE_KEY_ID,
  IPC_RESPONSE_VERIFY_KEY,
  MEMORY_IPC_AUTH_TOKEN,
  MEMORY_REQUESTS_DIR,
  MEMORY_RESPONSES_DIR,
  TASK_RESPONSES_DIR,
  agentId,
  appId,
  chatJid,
  memoryDefaultScope,
  memoryIpcAllowedActions,
  memoryReviewerIsControlApprover,
  memoryUserId,
  threadId,
} from './context.js';
import {
  createSignedIpcRequestEnvelope,
  verifyIpcResponsePayload,
} from './signing.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../../shared/private-fs.js';
import { makeIpcId, makeIpcJsonFilename } from './ipc-ids.js';

function removeStaleRequestFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort timeout cleanup.
  }
}

export function writeIpcFile(dir: string, data: object): string {
  ensurePrivateDirSync(dir);

  const filename = makeIpcJsonFilename();
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  const existingContext =
    'context' in data &&
    typeof data.context === 'object' &&
    data.context !== null &&
    !Array.isArray(data.context)
      ? (data.context as Record<string, unknown>)
      : {};
  const requestContext = {
    ...existingContext,
    ...(appId ? { appId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(IPC_RESPONSE_KEY_ID ? { responseKeyId: IPC_RESPONSE_KEY_ID } : {}),
  };
  const payload = {
    ...data,
    ...(Object.keys(requestContext).length > 0
      ? { context: requestContext }
      : {}),
  };
  const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload);
  writePrivateFileSync(tempPath, JSON.stringify(envelope, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

export function hasValidIpcResponseSignature(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  if (!IPC_RESPONSE_VERIFY_KEY) return false;
  const signature =
    typeof raw.signature === 'string' ? raw.signature.trim() : '';
  return verifyIpcResponsePayload(IPC_RESPONSE_VERIFY_KEY, payload, signature);
}

export async function requestMemoryAction(
  action: MemoryIpcAction,
  payload: Record<string, unknown>,
): Promise<{
  ok: boolean;
  provider?: string;
  data?: unknown;
  error?: string;
}> {
  ensurePrivateDirSync(MEMORY_REQUESTS_DIR);
  ensurePrivateDirSync(MEMORY_RESPONSES_DIR);

  const timeoutMs = getMemoryActionTimeoutMs(action);
  const requestId = makeIpcId('mem');
  const reqPath = path.join(MEMORY_REQUESTS_DIR, `${requestId}.json`);
  const tmpReqPath = `${reqPath}.tmp`;
  const requestPayload = {
    requestId,
    action,
    payload,
    context: {
      chatJid,
      ...(threadId ? { threadId } : {}),
      ...(memoryUserId ? { userId: memoryUserId } : {}),
      ...(IPC_RESPONSE_KEY_ID ? { responseKeyId: IPC_RESPONSE_KEY_ID } : {}),
      defaultScope: memoryDefaultScope,
      allowedActions: memoryIpcAllowedActions,
      reviewerIsControlApprover: memoryReviewerIsControlApprover,
    },
    expiresAt: new Date(currentTimeMs() + timeoutMs).toISOString(),
  };
  const requestEnvelope = createSignedIpcRequestEnvelope(
    MEMORY_IPC_AUTH_TOKEN,
    requestPayload,
  );
  writePrivateFileSync(tmpReqPath, JSON.stringify(requestEnvelope, null, 2));
  fs.renameSync(tmpReqPath, reqPath);

  const deadline = nowMs() + timeoutMs;
  const responsePath = path.join(MEMORY_RESPONSES_DIR, `${requestId}.json`);

  while (nowMs() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(responsePath, 'utf-8'),
        ) as Record<string, unknown>;
        const responseRequestId =
          typeof raw.requestId === 'string' ? raw.requestId : '';
        if (responseRequestId !== requestId) {
          throw new Error('Mismatched memory response requestId');
        }
        const data = {
          ok: Boolean(raw.ok),
          ...(typeof raw.provider === 'string'
            ? { provider: raw.provider }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(raw, 'data')
            ? { data: raw.data }
            : {}),
          ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        };
        const payload: Record<string, unknown> = {
          ok: data.ok,
          requestId,
          ...(data.provider ? { provider: data.provider } : {}),
          ...(Object.prototype.hasOwnProperty.call(data, 'data')
            ? { data: data.data }
            : {}),
          ...(data.error ? { error: data.error } : {}),
        };
        if (!hasValidIpcResponseSignature(raw, payload)) {
          throw new Error('Invalid memory response signature');
        }
        fs.unlinkSync(responsePath);
        return data;
      } catch (err) {
        try {
          fs.unlinkSync(responsePath);
        } catch {
          // ignore
        }
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse memory response',
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  removeStaleRequestFile(reqPath);
  return { ok: false, error: formatMemoryTimeoutError(timeoutMs) };
}

export async function requestBrowserAction(
  action: BrowserIpcAction,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  ensurePrivateDirSync(BROWSER_REQUESTS_DIR);
  ensurePrivateDirSync(BROWSER_RESPONSES_DIR);

  const timeoutMs = options.timeoutMs ?? 30_000;
  const requestId = makeIpcId('browser');
  const reqPath = path.join(BROWSER_REQUESTS_DIR, `${requestId}.json`);
  const tmpReqPath = `${reqPath}.tmp`;

  const requestPayload = {
    requestId,
    action,
    payload,
    context: {
      chatJid,
      timeoutMs,
      ...(threadId ? { threadId } : {}),
      ...(IPC_RESPONSE_KEY_ID ? { responseKeyId: IPC_RESPONSE_KEY_ID } : {}),
    },
    expiresAt: new Date(currentTimeMs() + timeoutMs).toISOString(),
  };
  const requestEnvelope = createSignedIpcRequestEnvelope(
    BROWSER_IPC_AUTH_TOKEN,
    requestPayload,
  );
  writePrivateFileSync(tmpReqPath, JSON.stringify(requestEnvelope, null, 2));
  fs.renameSync(tmpReqPath, reqPath);

  const deadline = nowMs() + timeoutMs;
  const responsePath = path.join(BROWSER_RESPONSES_DIR, `${requestId}.json`);

  while (nowMs() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(responsePath, 'utf-8'),
        ) as Record<string, unknown>;
        const responseRequestId =
          typeof raw.requestId === 'string' ? raw.requestId : '';
        if (responseRequestId !== requestId) {
          throw new Error('Mismatched browser response requestId');
        }
        const data = {
          ok: Boolean(raw.ok),
          ...(Object.prototype.hasOwnProperty.call(raw, 'data')
            ? { data: raw.data }
            : {}),
          ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        };
        const payload: Record<string, unknown> = {
          ok: data.ok,
          requestId,
          ...(Object.prototype.hasOwnProperty.call(data, 'data')
            ? { data: data.data }
            : {}),
          ...(data.error ? { error: data.error } : {}),
        };
        if (!hasValidIpcResponseSignature(raw, payload)) {
          throw new Error('Invalid browser response signature');
        }
        fs.unlinkSync(responsePath);
        return data;
      } catch (err) {
        try {
          fs.unlinkSync(responsePath);
        } catch {
          // ignore
        }
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse browser response',
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  removeStaleRequestFile(reqPath);
  return {
    ok: false,
    error: `Browser IPC timeout after ${timeoutMs}ms waiting for browser service response`,
  };
}

export interface TaskResponseEnvelope {
  taskId: string;
  ok: boolean;
  code?: string;
  message?: string;
  error?: string;
  details?: string[];
  data?: unknown;
  timestamp?: string;
}

function parseTaskResponseEnvelope(
  raw: unknown,
): { payload: TaskResponseEnvelope; raw: Record<string, unknown> } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
  if (!taskId || typeof row.ok !== 'boolean') return null;
  const details = Array.isArray(row.details)
    ? row.details
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : undefined;
  return {
    raw: row,
    payload: {
      taskId,
      ok: row.ok,
      ...(typeof row.code === 'string' ? { code: row.code } : {}),
      ...(typeof row.message === 'string' ? { message: row.message } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
      ...(details ? { details } : {}),
      ...(Object.prototype.hasOwnProperty.call(row, 'data')
        ? { data: row.data }
        : {}),
      ...(typeof row.timestamp === 'string'
        ? { timestamp: row.timestamp }
        : {}),
    },
  };
}

export async function waitForTaskResponse(
  taskId: string,
  timeoutMs = 15_000,
): Promise<TaskResponseEnvelope | null> {
  ensurePrivateDirSync(TASK_RESPONSES_DIR);
  const responsePath = path.join(TASK_RESPONSES_DIR, `task-${taskId}.json`);
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const parsedEnvelope = parseTaskResponseEnvelope(
          JSON.parse(fs.readFileSync(responsePath, 'utf-8')),
        );
        fs.unlinkSync(responsePath);
        if (!parsedEnvelope) {
          return {
            taskId,
            ok: false,
            error: 'Invalid task response payload',
          };
        }
        const payload = parsedEnvelope.payload as unknown as Record<
          string,
          unknown
        >;
        if (
          !hasValidIpcResponseSignature(parsedEnvelope.raw, {
            ...payload,
          })
        ) {
          return {
            taskId,
            ok: false,
            error: 'Invalid task response signature',
          };
        }
        return parsedEnvelope.payload;
      } catch (err) {
        try {
          fs.unlinkSync(responsePath);
        } catch {
          // ignore
        }
        return {
          taskId,
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse task response',
        };
      }
    }
    await sleep(150);
  }
  return null;
}
