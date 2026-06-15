import fs from 'fs';
import path from 'path';
import { MemoryIpcAction } from '@gantry/contracts';
import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
import {
  nowMs,
  nowMs as currentTimeMs,
  sleep,
} from '../../shared/time/datetime.js';
import { formatDuration } from '../../shared/human-format.js';
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
  TASKS_DIR,
  TASK_RESPONSES_DIR,
  agentId,
  appId,
  chatJid,
  groupFolder,
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
import {
  IpcSocketClient,
  IpcRequestError,
} from '../../shared/ipc-socket-client.js';
import { makeIpcId, makeIpcJsonFilename } from './ipc-ids.js';

function removeStaleRequestFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort timeout cleanup.
  }
}

/**
 * Build the signed task IPC envelope (context merge + ed25519-verifiable HMAC
 * signature) WITHOUT writing it anywhere. This is the exact payload the fs path
 * persists and the socket path sends as a `task` request frame, so both
 * transports are byte-for-byte identical at the wire/signature level.
 *
 * Returns the signed envelope which includes a `requestId` (used to correlate
 * the socket request/response).
 */
export function buildSignedTaskEnvelope(data: object): Record<string, unknown> {
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
  return createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload);
}

export function writeIpcFile(dir: string, data: object): string {
  ensurePrivateDirSync(dir);

  const filename = makeIpcJsonFilename();
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  const envelope = buildSignedTaskEnvelope(data);
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

export interface MemoryActionResult {
  ok: boolean;
  provider?: string;
  data?: unknown;
  error?: string;
}

/**
 * Build the signed memory IPC envelope (context merge + ed25519-verifiable HMAC
 * signature) WITHOUT writing it anywhere. This is the exact payload the fs path
 * persists to MEMORY_REQUESTS_DIR and the socket path sends as a `memory`
 * request frame, so the host re-verifies it identically (same memory token,
 * replay scope, and allowedActions) whether it arrived as a file or a frame.
 *
 * `requestId` is reused as the socket request/response correlation id.
 */
function buildSignedMemoryEnvelope(
  requestId: string,
  action: MemoryIpcAction,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Record<string, unknown> {
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
  return createSignedIpcRequestEnvelope(MEMORY_IPC_AUTH_TOKEN, requestPayload);
}

/**
 * Map a verified socket `memory` resp payload to the same shape the fs path
 * returns. The payload still carries `requestId`/`signature` (already verified
 * by the client); we keep only the fields requestMemoryAction surfaces.
 */
function memoryResultFromSocketResponse(
  resp: Record<string, unknown>,
): MemoryActionResult {
  return {
    ok: Boolean(resp.ok),
    ...(typeof resp.provider === 'string' ? { provider: resp.provider } : {}),
    ...(Object.prototype.hasOwnProperty.call(resp, 'data')
      ? { data: resp.data }
      : {}),
    ...(typeof resp.error === 'string' ? { error: resp.error } : {}),
  };
}

/**
 * Pure classification of a failed socket `memory` request, mirroring
 * classifyTaskSocketError. Memory has no `null` (timeout) return: instead the
 * fs path's deadline outcome is `{ ok:false, error: <timeout> }`, so:
 *  - timeout              → that same deadline result (do NOT replay via fs).
 *  - transient transport  → fall back to the durable fs mailbox (write+poll).
 *  - other {ok:false}     → a real signed handler rejection / bad_signature /
 *                           server transport error → surface as {ok:false}.
 */
export function classifyMemorySocketError(
  err: unknown,
  timeoutMs: number,
): { kind: 'result'; result: MemoryActionResult } | { kind: 'fallback' } {
  if (!(err instanceof IpcRequestError)) {
    // Unexpected non-protocol error → fall back to fs rather than fail hard.
    return { kind: 'fallback' };
  }
  if (err.code === 'timeout') {
    return {
      kind: 'result',
      result: { ok: false, error: formatMemoryTimeoutError(timeoutMs) },
    };
  }
  if (SOCKET_FALLBACK_CODES.has(err.code)) return { kind: 'fallback' };
  return { kind: 'result', result: { ok: false, error: err.message } };
}

export async function requestMemoryAction(
  action: MemoryIpcAction,
  payload: Record<string, unknown>,
): Promise<MemoryActionResult> {
  const timeoutMs = getMemoryActionTimeoutMs(action);
  const requestId = makeIpcId('mem');
  const requestEnvelope = buildSignedMemoryEnvelope(
    requestId,
    action,
    payload,
    timeoutMs,
  );

  // Socket/dual mode: route over the same mcp-role connection the runner uses,
  // reusing the byte-identical signed envelope. Transient failures fall back to
  // the durable fs mailbox below so a flaky socket never fails a memory action
  // the fs path would complete.
  const client = getTaskSocketClient();
  if (client) {
    const connected = await ensureTaskSocketConnected(client);
    if (connected) {
      try {
        const resp = await client.request('memory', requestEnvelope, {
          id: requestId,
          timeoutMs,
        });
        return memoryResultFromSocketResponse(resp);
      } catch (err) {
        const disposition = classifyMemorySocketError(err, timeoutMs);
        if (disposition.kind === 'result') return disposition.result;
        // 'fallback' → fall through to the durable fs mailbox below.
      }
    }
    // connect failed or transient request failure → fs fallback.
  }

  ensurePrivateDirSync(MEMORY_REQUESTS_DIR);
  ensurePrivateDirSync(MEMORY_RESPONSES_DIR);

  const reqPath = path.join(MEMORY_REQUESTS_DIR, `${requestId}.json`);
  const tmpReqPath = `${reqPath}.tmp`;
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
  action: BrowserBackendAction,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; publicToolName?: string } = {},
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
      ...(process.env.GANTRY_JOB_ID
        ? { jobId: process.env.GANTRY_JOB_ID }
        : {}),
      ...(process.env.GANTRY_JOB_RUN_ID
        ? { runId: process.env.GANTRY_JOB_RUN_ID }
        : {}),
      ...(threadId ? { threadId } : {}),
      ...(appId ? { appId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(options.publicToolName
        ? { publicToolName: options.publicToolName }
        : {}),
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
    error: `Browser IPC timeout after ${formatDuration(timeoutMs)} waiting for browser service response`,
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

// ---------------------------------------------------------------------------
// Socket task transport (Pillar 1, Task D)
//
// In socket/dual mode the grandchild routes its task requests over the same
// Unix-domain socket the runner uses, instead of the request-file + 150ms poll.
// The signed envelope is reused byte-for-byte (buildSignedTaskEnvelope), so the
// host re-verifies it identically whether it arrived as a file or a frame.
//
// Identity is read straight from process.env / context.js (no config/runtime/
// adapters/jobs imports — the grandchild keeps a minimal dependency surface).
// ---------------------------------------------------------------------------

type TaskTransportMode = 'fs' | 'socket' | 'dual';

function taskTransportMode(): TaskTransportMode {
  const raw = process.env.GANTRY_IPC_TRANSPORT?.trim();
  if (raw === 'socket' || raw === 'dual') return raw;
  return 'fs';
}

/**
 * Codes that mean "the socket did not deliver this request" — a transient issue
 * the durable fs mailbox can still complete. We fall back to writeIpcFile +
 * waitForTaskResponse so a flaky socket never fails a task that fs would finish.
 *
 * `busy` is the server's per-connection in-flight backpressure (D6), not a
 * hard rate limit, so it is also safe to retry via fs.
 */
const SOCKET_FALLBACK_CODES = new Set([
  'connection_lost',
  'not_connected',
  'busy',
]);

/**
 * The slice of IpcSocketClient that sendTaskRequest and the socket branch of
 * requestMemoryAction depend on. Narrowed so a test can inject a fake to
 * exercise the timeout/fallback/ok:false branches without standing up a real
 * socket. The same lazily-built mcp-role client serves both the `task` and
 * `memory` channels.
 */
export interface TaskSocketClientLike {
  readonly connected: boolean;
  connect(): Promise<void>;
  request(
    channel: 'task' | 'memory',
    signedPayload: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

let taskSocketClient: TaskSocketClientLike | undefined;
let taskSocketClientBuilt = false;
let taskSocketConnectPromise: Promise<void> | undefined;
let taskSocketClientOverride: TaskSocketClientLike | null | undefined;

/**
 * Test-only seam: force getTaskSocketClient to return the given client (or
 * `null` to force the fs path) regardless of env. Pass `undefined` to clear.
 */
export function __setTaskSocketClientForTest(
  client: TaskSocketClientLike | null | undefined,
): void {
  taskSocketClientOverride = client;
  taskSocketConnectPromise = undefined;
}

/**
 * Lazily build (once) the module-level mcp-role socket client. Returns undefined
 * unless transport is socket/dual AND a socket path is configured. The connect()
 * handshake is kicked off here but awaited lazily on the first request.
 */
function getTaskSocketClient(): TaskSocketClientLike | undefined {
  if (taskSocketClientOverride !== undefined) {
    return taskSocketClientOverride ?? undefined;
  }
  if (taskSocketClientBuilt) return taskSocketClient;
  taskSocketClientBuilt = true;

  if (taskTransportMode() === 'fs') return undefined;
  const socketPath = process.env.GANTRY_IPC_SOCKET_PATH?.trim();
  if (!socketPath) return undefined;

  taskSocketClient = new IpcSocketClient({
    socketPath,
    buildHello: () =>
      createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, {
        kind: 'hello',
        role: 'mcp',
        folder: groupFolder,
        context: {
          ...(threadId ? { threadId } : {}),
          ...(appId ? { appId } : {}),
          ...(agentId ? { agentId } : {}),
        },
      }),
    verifyResponse: (p, sig) =>
      verifyIpcResponsePayload(IPC_RESPONSE_VERIFY_KEY, p, sig),
    reconnect: { enabled: true },
    // The grandchild is a long-lived stdio MCP server: its lifetime is pinned by
    // the stdin transport, not this socket. unref() the socket so a still-open
    // (never explicitly closed) task connection can't keep the process alive
    // after the parent closes stdin — otherwise the grandchild hangs on exit.
    unref: true,
  });
  return taskSocketClient;
}

/**
 * Ensure the socket client is connected. Caches the in-flight connect promise so
 * concurrent task calls share one handshake. Resolves true when connected, false
 * if the connect failed (caller then falls back to fs).
 */
async function ensureTaskSocketConnected(
  client: TaskSocketClientLike,
): Promise<boolean> {
  if (client.connected) return true;
  if (!taskSocketConnectPromise) {
    taskSocketConnectPromise = client.connect();
  }
  try {
    await taskSocketConnectPromise;
    return client.connected;
  } catch {
    return false;
  } finally {
    // Clear so a later call after a drop can retry the handshake.
    taskSocketConnectPromise = undefined;
  }
}

/**
 * Pure classification of a failed socket `task` request into one of three
 * dispositions. Extracted so the branch matrix is unit-testable without a live
 * socket:
 *  - { kind: 'null' }      → the caller observes a timeout (return null).
 *  - { kind: 'fallback' }  → transient transport issue; retry via the durable fs
 *                            mailbox so a flaky socket never fails a task fs
 *                            would have completed.
 *  - { kind: 'response' }  → a real {ok:false} (signed handler rejection,
 *                            bad_signature, or a server transport error like
 *                            invalid_request / internal_error / rate_limited).
 */
export function classifyTaskSocketError(
  taskId: string,
  err: unknown,
):
  | { kind: 'null' }
  | { kind: 'fallback' }
  | { kind: 'response'; response: TaskResponseEnvelope } {
  if (!(err instanceof IpcRequestError)) {
    // Unexpected non-protocol error → fall back to fs rather than fail hard.
    return { kind: 'fallback' };
  }
  if (err.code === 'timeout') return { kind: 'null' };
  if (SOCKET_FALLBACK_CODES.has(err.code)) return { kind: 'fallback' };
  return {
    kind: 'response',
    response: { taskId, ok: false, code: err.code, error: err.message },
  };
}

/**
 * Send a task request and await its response.
 *
 * - fs mode (default): writeIpcFile(TASKS_DIR, …) + waitForTaskResponse —
 *   byte-identical to the legacy path.
 * - socket/dual mode (client available): send the signed envelope as a `task`
 *   frame. Timeout → null. A transient socket failure (connection lost / not
 *   connected / busy / connect-fail) → fall back to the fs path. A signed
 *   {ok:false} or other server-side rejection → TaskResponseEnvelope{ok:false}.
 *
 * `opts.timeoutMs` is forwarded into request() so long waits (e.g. the
 * scheduler's 300s) are honored and never clamped to the 15s default (R6).
 */
export async function sendTaskRequest(
  data: { taskId: string } & Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<TaskResponseEnvelope | null> {
  const taskId = data.taskId;
  const client = getTaskSocketClient();

  if (client) {
    const signed = buildSignedTaskEnvelope(data);
    const connected = await ensureTaskSocketConnected(client);
    if (connected) {
      try {
        const resp = await client.request('task', signed, {
          id: String(signed.requestId),
          timeoutMs: opts.timeoutMs,
        });
        return resp as unknown as TaskResponseEnvelope;
      } catch (err) {
        const disposition = classifyTaskSocketError(taskId, err);
        if (disposition.kind === 'null') return null;
        if (disposition.kind === 'response') return disposition.response;
        // 'fallback' → fall through to the durable fs mailbox below.
      }
    }
    // connect failed or transient request failure → fs fallback.
  }

  writeIpcFile(TASKS_DIR, data);
  return waitForTaskResponse(taskId, opts.timeoutMs);
}
