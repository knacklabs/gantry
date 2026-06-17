import { MemoryIpcAction } from '@gantry/contracts';
import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { formatDuration } from '../../shared/human-format.js';
import {
  formatMemoryTimeoutError,
  getMemoryActionTimeoutMs,
} from '../memory-timeouts.js';
import {
  BROWSER_IPC_AUTH_TOKEN,
  IPC_AUTH_TOKEN,
  IPC_RESPONSE_KEY_ID,
  IPC_RESPONSE_VERIFY_KEY,
  MEMORY_IPC_AUTH_TOKEN,
  agentId,
  appId,
  groupFolder,
  memoryDefaultScope,
  memoryIpcAllowedActions,
  memoryReviewerIsControlApprover,
  runHandle,
} from './context.js';
import { getBoundChatJid, getBoundRuntimeScope } from './bound-identity.js';
import {
  createSignedIpcRequestEnvelope,
  verifyIpcResponsePayload,
} from './signing.js';
import {
  IpcSocketClient,
  IpcRequestError,
} from '../../shared/ipc-socket-client.js';
import { replaceCachedLiveToolRulesFromPayload } from '../../shared/live-tool-rules.js';
import { makeIpcId } from './ipc-ids.js';

/**
 * Build the signed task IPC envelope (context merge + ed25519-verifiable HMAC
 * signature) WITHOUT writing it anywhere. This is the exact payload the socket
 * path sends as a `task` request frame.
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
  const boundScope = getBoundRuntimeScope();
  const boundThreadId = boundScope.threadId;
  const responseKeyId = boundScope.ipcResponseKeyId ?? IPC_RESPONSE_KEY_ID;
  const requestContext = {
    ...existingContext,
    ...(appId ? { appId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(boundThreadId ? { threadId: boundThreadId } : {}),
    ...(responseKeyId ? { responseKeyId } : {}),
  };
  const payload = {
    ...data,
    ...(boundScope.runHandle ? { runHandle: boundScope.runHandle } : {}),
    ...(Object.keys(requestContext).length > 0
      ? { context: requestContext }
      : {}),
  };
  return createSignedIpcRequestEnvelope(
    boundScope.ipcAuthToken ?? IPC_AUTH_TOKEN,
    payload,
  );
}

export function hasValidIpcResponseSignature(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  const verifyKey =
    getBoundRuntimeScope().ipcResponseVerifyKey ?? IPC_RESPONSE_VERIFY_KEY;
  if (!verifyKey) return false;
  const signature =
    typeof raw.signature === 'string' ? raw.signature.trim() : '';
  return verifyIpcResponsePayload(verifyKey, payload, signature);
}

export interface MemoryActionResult {
  ok: boolean;
  provider?: string;
  data?: unknown;
  error?: string;
}

/**
 * Build the signed memory IPC envelope (context merge + ed25519-verifiable HMAC
 * signature) WITHOUT writing it anywhere. This is the exact payload the socket
 * path sends as a `memory` request frame, so the host re-verifies it with the
 * same memory token, replay scope, and allowedActions.
 *
 * `requestId` is reused as the socket request/response correlation id.
 */
function buildSignedMemoryEnvelope(
  requestId: string,
  action: MemoryIpcAction,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Record<string, unknown> {
  const boundScope = getBoundRuntimeScope();
  const responseKeyId = boundScope.ipcResponseKeyId ?? IPC_RESPONSE_KEY_ID;
  const requestPayload = {
    requestId,
    action,
    payload,
    context: {
      chatJid: boundScope.chatJid,
      ...(boundScope.threadId ? { threadId: boundScope.threadId } : {}),
      ...(appId ? { appId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(boundScope.memoryUserId ? { userId: boundScope.memoryUserId } : {}),
      ...(responseKeyId ? { responseKeyId } : {}),
      defaultScope: memoryDefaultScope,
      allowedActions: memoryIpcAllowedActions,
      reviewerIsControlApprover: memoryReviewerIsControlApprover,
    },
    expiresAt: new Date(currentTimeMs() + timeoutMs).toISOString(),
  };
  return createSignedIpcRequestEnvelope(
    boundScope.memoryIpcAuthToken ?? MEMORY_IPC_AUTH_TOKEN,
    requestPayload,
  );
}

/**
 * Map a verified socket `memory` resp payload to the public result shape. The
 * payload still carries `requestId`/`signature` (already verified by the
 * client); we keep only the fields requestMemoryAction surfaces.
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
 * classifyTaskSocketError. Memory has no `null` (timeout) return, so:
 *  - timeout              → that same deadline result (do NOT replay via fs).
 *  - transient transport  → bounded `{ ok:false }` socket error.
 *  - other {ok:false}     → a real signed handler rejection / bad_signature /
 *                           server transport error → surface as {ok:false}.
 */
export function classifyMemorySocketError(
  err: unknown,
  timeoutMs: number,
): { kind: 'result'; result: MemoryActionResult } {
  if (!(err instanceof IpcRequestError)) {
    return {
      kind: 'result',
      result: {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (err.code === 'timeout') {
    return {
      kind: 'result',
      result: { ok: false, error: formatMemoryTimeoutError(timeoutMs) },
    };
  }
  return { kind: 'result', result: { ok: false, error: err.message } };
}

/**
 * Pure classification of a failed socket `user_question` request.
 *  - timeout              → the question genuinely timed out; surface the same
 *                           "timed out" disposition.
 *  - transient transport  → bounded socket error.
 *  - other {ok:false}     → a server transport error (invalid_request /
 *                           internal_error / rate_limited / busy) as text.
 */
export function classifyUserQuestionSocketError(
  err: unknown,
): { kind: 'timeout' } | { kind: 'result'; text: string } {
  if (!(err instanceof IpcRequestError)) {
    return {
      kind: 'result',
      text: err instanceof Error ? err.message : String(err),
    };
  }
  if (err.code === 'timeout') return { kind: 'timeout' };
  return { kind: 'result', text: err.message };
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

  // Socket-only mode: route over the same mcp-role connection the runner uses,
  // reusing the byte-identical signed envelope.
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
        return classifyMemorySocketError(err, timeoutMs).result;
      }
    }
    return { ok: false, error: 'IPC socket is not connected' };
  }
  return { ok: false, error: 'IPC socket is not connected' };
}

export interface BrowserActionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Build the signed browser IPC envelope (chat-scoped browser HMAC token) WITHOUT
 * writing it anywhere. This is the exact payload the socket path sends as a
 * `browser` request frame, so the host re-verifies it with the same browser
 * token, chatJid binding, and freshness/replay scope.
 *
 * `requestId` is reused as the socket request/response correlation id.
 */
function buildSignedBrowserEnvelope(
  requestId: string,
  action: BrowserBackendAction,
  payload: Record<string, unknown>,
  timeoutMs: number,
  publicToolName: string | undefined,
): Record<string, unknown> {
  const boundScope = getBoundRuntimeScope();
  const responseKeyId = boundScope.ipcResponseKeyId ?? IPC_RESPONSE_KEY_ID;
  const requestPayload = {
    requestId,
    action,
    payload,
    context: {
      chatJid: getBoundChatJid(),
      timeoutMs,
      ...(process.env.GANTRY_JOB_ID
        ? { jobId: process.env.GANTRY_JOB_ID }
        : {}),
      ...(process.env.GANTRY_JOB_RUN_ID
        ? { runId: process.env.GANTRY_JOB_RUN_ID }
        : {}),
      ...(boundScope.threadId ? { threadId: boundScope.threadId } : {}),
      ...(appId ? { appId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(publicToolName ? { publicToolName } : {}),
      ...(responseKeyId ? { responseKeyId } : {}),
    },
    expiresAt: new Date(currentTimeMs() + timeoutMs).toISOString(),
  };
  return createSignedIpcRequestEnvelope(
    boundScope.browserIpcAuthToken ?? BROWSER_IPC_AUTH_TOKEN,
    requestPayload,
  );
}

/**
 * Map a verified socket `browser` resp payload to the public result shape. The
 * payload still carries `requestId`/`signature` (already verified by the
 * client); we keep only the fields requestBrowserAction surfaces.
 */
function browserResultFromSocketResponse(
  resp: Record<string, unknown>,
): BrowserActionResult {
  return {
    ok: Boolean(resp.ok),
    ...(Object.prototype.hasOwnProperty.call(resp, 'data')
      ? { data: resp.data }
      : {}),
    ...(typeof resp.error === 'string' ? { error: resp.error } : {}),
  };
}

/**
 * Pure classification of a failed socket `browser` request, mirroring
 * classifyMemorySocketError. Browser has no `null` (timeout) return, so:
 *  - timeout              → that same deadline result (do NOT replay via fs).
 *  - transient transport  → bounded `{ ok:false }` socket error.
 *  - other {ok:false}     → a real signed handler rejection / bad_signature /
 *                           server transport error (invalid_request /
 *                           internal_error / rate_limited) → surface as
 *                           {ok:false}.
 */
export function classifyBrowserSocketError(
  err: unknown,
  timeoutMs: number,
): { kind: 'result'; result: BrowserActionResult } {
  if (!(err instanceof IpcRequestError)) {
    return {
      kind: 'result',
      result: {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (err.code === 'timeout') {
    return {
      kind: 'result',
      result: {
        ok: false,
        error: `Browser IPC timeout after ${formatDuration(timeoutMs)} waiting for browser service response`,
      },
    };
  }
  return { kind: 'result', result: { ok: false, error: err.message } };
}

export async function requestBrowserAction(
  action: BrowserBackendAction,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; publicToolName?: string } = {},
): Promise<BrowserActionResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const requestId = makeIpcId('browser');
  const requestEnvelope = buildSignedBrowserEnvelope(
    requestId,
    action,
    payload,
    timeoutMs,
    options.publicToolName,
  );

  // Socket-only mode: route over the same mcp-role connection the runner uses,
  // reusing the byte-identical signed envelope. The server enforces the shared
  // cap-4 browser concurrency.
  const client = getTaskSocketClient();
  if (client) {
    const connected = await ensureTaskSocketConnected(client);
    if (connected) {
      try {
        const resp = await client.request('browser', requestEnvelope, {
          id: requestId,
          timeoutMs,
        });
        return browserResultFromSocketResponse(resp);
      } catch (err) {
        return classifyBrowserSocketError(err, timeoutMs).result;
      }
    }
    return { ok: false, error: 'IPC socket is not connected' };
  }
  return { ok: false, error: 'IPC socket is not connected' };
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

// ---------------------------------------------------------------------------
// Socket task transport (Pillar 1, Task D)
//
// The grandchild routes its task requests over the same Unix-domain socket the
// runner uses.
// The signed envelope is reused byte-for-byte (buildSignedTaskEnvelope), so the
// host re-verifies it on the frame.
//
// Identity is read straight from process.env / context.js (no config/runtime/
// adapters/jobs imports — the grandchild keeps a minimal dependency surface).
// ---------------------------------------------------------------------------

/**
 * The slice of IpcSocketClient that the grandchild's socket branches depend on.
 * Narrowed so a test can inject a fake to exercise the timeout/ok:false
 * branches without standing up a real socket. The same lazily-built mcp-role
 * client serves the `task`, `memory`, `user_question` (req→resp) and `message`
 * (fire-and-forget) channels.
 */
export interface TaskSocketClientLike {
  readonly connected: boolean;
  connect(): Promise<void>;
  request(
    channel: 'task' | 'memory' | 'user_question' | 'browser',
    signedPayload: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  /** Fire-and-forget send (no response frame). Used for the `message` channel. */
  send(channel: 'message', signedPayload: Record<string, unknown>): void;
}

/**
 * Accessor for the lazily-built mcp-role socket client, shared across all
 * grandchild channels (task/memory/user_question/message). Returns undefined
 * when no socket path is configured. Exported so the messaging tools
 * (send_message / ask_user_question) reuse the same connection.
 */
export function getMcpSocketClient(): TaskSocketClientLike | undefined {
  return getTaskSocketClient();
}

/**
 * Ensure the shared mcp-role socket client is connected (caching the in-flight
 * handshake). Resolves true when connected, false if the connect failed (the
 * caller returns a bounded socket error). Exported for the messaging tools.
 */
export function ensureMcpSocketConnected(
  client: TaskSocketClientLike,
): Promise<boolean> {
  return ensureTaskSocketConnected(client);
}

let taskSocketClient: TaskSocketClientLike | undefined;
let taskSocketClientBuilt = false;
let taskSocketConnectPromise: Promise<void> | undefined;
let taskSocketClientOverride: TaskSocketClientLike | null | undefined;

/**
 * Test-only seam: force getTaskSocketClient to return the given client (or
 * `null` to force no client) regardless of env. Pass `undefined` to clear.
 */
export function __setTaskSocketClientForTest(
  client: TaskSocketClientLike | null | undefined,
): void {
  taskSocketClientOverride = client;
  taskSocketConnectPromise = undefined;
}

/**
 * Lazily build (once) the module-level mcp-role socket client. Returns undefined
 * unless a socket path is configured. The connect() handshake is awaited lazily
 * on the first request.
 */
function getTaskSocketClient(): TaskSocketClientLike | undefined {
  if (taskSocketClientOverride !== undefined) {
    return taskSocketClientOverride ?? undefined;
  }
  if (taskSocketClientBuilt) return taskSocketClient;
  taskSocketClientBuilt = true;

  const socketPath = process.env.GANTRY_IPC_SOCKET_PATH?.trim();
  if (!socketPath) return undefined;

  taskSocketClient = new IpcSocketClient({
    socketPath,
    buildHello: () =>
      buildSignedTaskEnvelope({
        kind: 'hello',
        role: 'mcp',
        ...((getBoundRuntimeScope().runHandle ?? runHandle)
          ? { runHandle: getBoundRuntimeScope().runHandle ?? runHandle }
          : {}),
        folder: groupFolder,
      }),
    verifyResponse: (p, sig) =>
      verifyIpcResponsePayload(
        getBoundRuntimeScope().ipcResponseVerifyKey ?? IPC_RESPONSE_VERIFY_KEY,
        p,
        sig,
      ),
    onPush: (frame) => {
      if (frame.channel === 'live_tool_rules') {
        replaceCachedLiveToolRulesFromPayload(frame.payload);
      }
    },
    reconnect: {
      enabled: true,
      replayPending: true,
    },
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
 * if the connect failed.
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
 *  - { kind: 'response' }  → a real {ok:false} (signed handler rejection,
 *                            bad_signature, or a server transport error like
 *                            invalid_request / internal_error / rate_limited).
 */
export function classifyTaskSocketError(
  taskId: string,
  err: unknown,
): { kind: 'null' } | { kind: 'response'; response: TaskResponseEnvelope } {
  if (!(err instanceof IpcRequestError)) {
    return {
      kind: 'response',
      response: {
        taskId,
        ok: false,
        code: 'socket_error',
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (err.code === 'timeout') return { kind: 'null' };
  return {
    kind: 'response',
    response: { taskId, ok: false, code: err.code, error: err.message },
  };
}

/**
 * Send a task request and await its response.
 *
 * - socket mode: send the signed envelope as a `task` frame. Timeout → null.
 *   A transient socket failure returns TaskResponseEnvelope{ok:false}.
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
  const signed = buildSignedTaskEnvelope(data);

  if (client) {
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
        return disposition.response;
      }
    }
    return {
      taskId,
      ok: false,
      code: 'not_connected',
      error: 'IPC socket is not connected',
    };
  }
  return {
    taskId,
    ok: false,
    code: 'not_connected',
    error: 'IPC socket is not connected',
  };
}
