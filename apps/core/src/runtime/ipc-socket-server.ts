import path from 'path';
import type net from 'net';
import { randomUUID } from 'crypto';

import {
  DATA_DIR,
  IPC_FRAME_MAX_BYTES,
  IPC_HEARTBEAT_INTERVAL_MS,
  ipcSocketPathFor,
} from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { computeIpcAuthToken } from './ipc-auth.js';
import {
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '../infrastructure/ipc/request-signing.js';
import {
  bindIpcSocket,
  releaseIpcSocket,
  type SocketBindResult,
} from './ipc-socket-bind.js';
import {
  IpcConnection,
  type IpcConnectionScope,
} from '../shared/ipc-connection.js';
import {
  registerIpcResponder,
  takeIpcResponder,
} from './ipc-response-router.js';
import { canProcessIpcFile } from './ipc-rate-limit.js';
import { parseTaskIpcData } from './ipc-task-parsing.js';
import {
  parseBrowserIpcRequest,
  parseIpcMessage,
  parseMemoryIpcRequest,
  parsePermissionIpcRequest,
  parseUserQuestionIpcRequest,
} from './ipc-parsing.js';
import { validatePermissionIpcJobExecutionTarget } from './ipc.js';
import {
  getIpcResponseSigningPrivateKey,
  isBrowserIpcAuthorized,
  revokeIpcResponseSigningKey,
} from './ipc-auth.js';
import { processTaskIpc } from '../jobs/ipc-handler.js';
import {
  processMemoryRequest,
  writeMemoryResponse,
} from '../memory/memory-ipc.js';
import {
  interactionInFlightKey,
  processPermissionInteractionIpc,
  processUserQuestionInteractionIpc,
  writePermissionInteractionFailure,
  writeUserQuestionInteractionFailure,
} from './ipc-interaction-processing.js';
import {
  releaseInteractionInFlight,
  tryAdmitInteractionInFlight,
} from './ipc-interaction-inflight.js';
import {
  releaseBrowserInFlight,
  tryAcquireBrowserInFlight,
} from './ipc-browser-inflight.js';
import {
  runBrowserIpcRequest,
  writeBrowserFailureResponse,
} from './ipc-browser-requests.js';
import type { IpcDeps } from './ipc-domain-types.js';
import {
  isIpcWireChannel,
  type IpcWireChannel,
  type IpcWireFrame,
  type IpcWireError,
} from '../shared/ipc-wire.js';
import {
  readLiveToolRules,
  subscribeLiveToolRules,
} from '../shared/live-tool-rules.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IpcSocketServerHandle {
  socketPath: string;
  stop(): Promise<void>;
  /** Connections currently bound to a folder — for push delivery (later) + tests. */
  connectionsForFolder(folder: string): IpcConnection[];
}

export interface IpcSocketServerOptions {
  socketPath?: string;
  ipcBaseDir?: string;
  /** Drop a connection that has not handshaked within this many ms. Default 5000. */
  handshakeTimeoutMs?: number;
  /** Max concurrent in-flight requests per connection. Default 64. */
  maxInFlightPerConnection?: number;
  /**
   * Optional platform peer-credential helper. Node does not expose SO_PEERCRED /
   * getpeereid natively; when a helper is unavailable it should return
   * undefined and the 0o700 socket directory + signed handshake remain the
   * primary isolation. A returned UID must match the core process UID.
   */
  peerUidProvider?: (socket: net.Socket) => number | undefined;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_MAX_IN_FLIGHT = 64;

// ---------------------------------------------------------------------------
// Per-connection bookkeeping kept outside IpcConnection (it owns transport
// framing/heartbeat only; scope binding + in-flight accounting live here).
// ---------------------------------------------------------------------------

interface ConnState {
  handshakeTimer?: ReturnType<typeof setTimeout>;
  inFlight: number;
  /**
   * Response-router keys (folder-scoped correlationIds) this connection has a
   * single-shot responder registered under, for each request still in flight.
   * On a mid-flight drop `onClose` purges any still-registered responder here so
   * a late handler resolution cannot deliver to (or leak on) a dead connection.
   */
  responderKeys: Set<string>;
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

function transportError(
  id: string,
  channel: IpcWireChannel | null,
  code: string,
): IpcWireFrame {
  return {
    v: 1,
    type: 'resp',
    channel,
    id,
    payload: { ok: false, code, transport: true },
  };
}

function coerceOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function roleCanSendRequest(
  role: IpcConnectionScope['role'],
  channel: IpcWireChannel | null,
): boolean {
  if (role === 'runner') return channel === 'permission';
  return (
    channel === 'task' ||
    channel === 'memory' ||
    channel === 'browser' ||
    channel === 'user_question' ||
    channel === 'message'
  );
}

function isSupportedRequestChannel(
  channel: IpcWireChannel | null,
): channel is Exclude<
  IpcWireChannel,
  'continuation' | 'close' | 'bind' | 'live_tool_rules'
> {
  return (
    channel === 'task' ||
    channel === 'memory' ||
    channel === 'browser' ||
    channel === 'user_question' ||
    channel === 'message' ||
    channel === 'permission'
  );
}

interface ParsedSocketScopeBinding {
  threadId?: string | null;
  appId?: string | null;
  agentId?: string | null;
}

function normalizeScopeString(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function assertBoundScopeMatches(
  scope: IpcConnectionScope | undefined,
  actual: ParsedSocketScopeBinding,
  label: string,
): void {
  if (!scope) throw new Error(`${label} connection scope is missing`);
  const expectedThreadId = normalizeScopeString(scope.threadId);
  const expectedAppId = normalizeScopeString(scope.appId);
  const expectedAgentId = normalizeScopeString(scope.agentId);
  const actualThreadId = normalizeScopeString(actual.threadId);
  const actualAppId = normalizeScopeString(actual.appId);
  const actualAgentId = normalizeScopeString(actual.agentId);
  if (expectedThreadId && actualThreadId !== expectedThreadId) {
    throw new Error(`${label} threadId does not match connection scope`);
  }
  if (expectedAppId && actualAppId !== expectedAppId) {
    throw new Error(`${label} appId does not match connection scope`);
  }
  if (expectedAgentId && actualAgentId !== expectedAgentId) {
    throw new Error(`${label} agentId does not match connection scope`);
  }
}

// ---------------------------------------------------------------------------
// startIpcSocketServer
// ---------------------------------------------------------------------------

export async function startIpcSocketServer(
  deps: IpcDeps,
  opts: IpcSocketServerOptions = {},
): Promise<IpcSocketServerHandle | undefined> {
  const ipcBaseDir = opts.ipcBaseDir ?? path.join(DATA_DIR, 'ipc');
  const socketPath = opts.socketPath ?? ipcSocketPathFor(ipcBaseDir);
  const handshakeTimeoutMs =
    opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxInFlight = opts.maxInFlightPerConnection ?? DEFAULT_MAX_IN_FLIGHT;
  const expectedPeerUid = process.getuid?.();

  const connections = new Set<IpcConnection>();
  const byFolder = new Map<string, Set<IpcConnection>>();
  const state = new WeakMap<IpcConnection, ConnState>();

  // -------------------------------------------------------------------------
  // In-flight bookkeeping helpers. A dispatcher registers a single-shot
  // responder for its request, then runs the handler; on completion (success,
  // failure, or rate-limit fallback) the responder is consumed by the write
  // chokepoint or explicitly taken. We mirror BOTH the in-flight slot counter
  // and the per-connection set of registered responder keys here so a mid-flight
  // connection drop can free the slots (cap recovers) and purge the responders
  // (no leak; no delivery to a dead connection) in `onClose`.
  // -------------------------------------------------------------------------
  function beginInFlight(conn: IpcConnection, responderKey: string): void {
    const st = state.get(conn);
    if (!st) return;
    st.inFlight += 1;
    st.responderKeys.add(responderKey);
  }

  function endInFlight(conn: IpcConnection, responderKey: string): void {
    const st = state.get(conn);
    if (!st) return;
    if (st.inFlight > 0) st.inFlight -= 1;
    st.responderKeys.delete(responderKey);
  }

  function groupIpcDir(folder: string): string {
    return path.join(ipcBaseDir, folder);
  }

  function sendLiveToolRulesSnapshot(
    conn: IpcConnection,
    runHandle: string,
    rules: readonly string[],
  ): void {
    conn.send({
      v: 1,
      type: 'push',
      channel: 'live_tool_rules',
      id: `live-tool-rules:${runHandle}`,
      payload: { runHandle, rules: [...rules] },
    });
  }

  function sendCurrentLiveToolRules(conn: IpcConnection): void {
    const scope = conn.scope;
    const runHandle = scope?.runHandle?.trim();
    if (
      !scope ||
      (scope.role !== 'runner' && scope.role !== 'mcp') ||
      !runHandle
    ) {
      return;
    }
    sendLiveToolRulesSnapshot(
      conn,
      runHandle,
      readLiveToolRules({
        ipcDir: groupIpcDir(scope.sourceAgentFolder),
        runHandle,
      }),
    );
  }

  const unsubscribeLiveToolRules = subscribeLiveToolRules((snapshot) => {
    const changedDir = path.resolve(snapshot.ipcDir);
    for (const [folder, set] of byFolder) {
      if (path.resolve(groupIpcDir(folder)) !== changedDir) continue;
      for (const conn of set) {
        if (conn.scope?.runHandle !== snapshot.runHandle) continue;
        sendLiveToolRulesSnapshot(conn, snapshot.runHandle, snapshot.rules);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Handshake validation — low-level token possession check. Returns the bound
  // scope on success, or undefined (with a reason logged) on any failure. We do
  // NOT leak which check failed to the client.
  // -------------------------------------------------------------------------
  function validateHello(
    payload: Record<string, unknown>,
  ): { scope: IpcConnectionScope } | { reason: string } {
    // 1. Folder: must be a valid group folder AND a registered conversation route.
    const folder = String(payload.folder ?? '');
    if (!isValidGroupFolder(folder)) {
      return { reason: 'invalid_folder' };
    }
    const routes = deps.conversationRoutes();
    const registered = Object.values(routes).some(
      (route) => route.folder === folder,
    );
    if (!registered) {
      return { reason: 'unregistered_folder' };
    }

    // 2. Role + context.
    const role = payload.role;
    if (role !== 'runner' && role !== 'mcp') {
      return { reason: 'invalid_role' };
    }
    const context =
      payload.context && typeof payload.context === 'object'
        ? (payload.context as Record<string, unknown>)
        : {};
    const threadId = coerceOptionalString(context.threadId);
    const responseKeyId = coerceOptionalString(context.responseKeyId);
    const appId = coerceOptionalString(context.appId);
    const agentId = coerceOptionalString(context.agentId);

    // 3. Derive the expected token from the claimed scope.
    const token = computeIpcAuthToken(folder, threadId, { appId, agentId });

    // 4. Freshness (requestId + nonce + expiresAt).
    const freshness = validateIpcRequestFreshness(payload);
    if (!freshness.ok) {
      return { reason: `stale_hello: ${freshness.reason}` };
    }

    // 5. Signature over the payload minus signature/authToken.
    const copy: Record<string, unknown> = { ...payload };
    delete copy.signature;
    delete copy.authToken;
    if (
      !verifyIpcRequestPayload(token, copy, String(payload.signature ?? ''))
    ) {
      return { reason: 'bad_signature' };
    }

    // 6. Build the scope.
    const runHandle = coerceOptionalString(payload.runHandle);
    const scope: IpcConnectionScope = {
      sourceAgentFolder: folder,
      role,
      threadId,
      responseKeyId,
      appId,
      agentId,
      runHandle,
    };
    return { scope };
  }

  // -------------------------------------------------------------------------
  // dispatchRequest — runs DETACHED (not awaited) so concurrent requests on one
  // connection do not head-of-line block.
  // -------------------------------------------------------------------------
  async function dispatchRequest(
    frame: IpcWireFrame,
    conn: IpcConnection,
  ): Promise<void> {
    const folder = conn.scope!.sourceAgentFolder;
    const channel = frame.channel;

    if (channel === 'task') {
      await dispatchTask(frame, conn, folder);
      return;
    }

    if (channel === 'memory') {
      await dispatchMemory(frame, conn, folder);
      return;
    }

    if (channel === 'user_question') {
      await dispatchUserQuestion(frame, conn, folder);
      return;
    }

    if (channel === 'permission') {
      await dispatchPermission(frame, conn, folder);
      return;
    }

    if (channel === 'browser') {
      await dispatchBrowser(frame, conn, folder);
      return;
    }

    if (channel === 'message') {
      // Fire-and-forget; no response frame.
      if (!canProcessIpcFile(folder, 'messages')) {
        logger.warn({ folder }, 'IPC message rate-limited');
        return;
      }
      let data;
      try {
        data = parseIpcMessage(frame.payload, folder);
        assertBoundScopeMatches(
          conn.scope,
          { threadId: data.threadId },
          'IPC message',
        );
      } catch (err) {
        logger.warn({ err, folder }, 'rejected message frame');
        return;
      }
      // Folder-owns-JID authz: only deliver to a JID this folder owns.
      const route = deps.conversationRoutes()[data.chatJid];
      if (!route || route.folder !== folder) {
        logger.warn(
          { folder, chatJid: data.chatJid },
          'message frame target JID not owned by folder',
        );
        return;
      }
      try {
        await deps.sendMessage(
          data.chatJid,
          data.text,
          data.threadId ? { threadId: data.threadId } : undefined,
        );
      } catch (err) {
        logger.warn({ err, folder }, 'sendMessage from IPC message failed');
      }
      return;
    }

    // All req→resp channels (task/memory/user_question/permission/browser) plus
    // the fire-and-forget message channel are cut over. Anything else (e.g. a
    // future channel a newer worker speaks) is an explicit reject.
    conn.send(transportError(frame.id, channel, 'unsupported_channel'));
  }

  async function dispatchTask(
    frame: IpcWireFrame,
    conn: IpcConnection,
    folder: string,
  ): Promise<void> {
    if (!canProcessIpcFile(folder, 'tasks')) {
      // Unsigned transport-level error: the client treats an error response as
      // a failed request without invoking the domain task handler.
      conn.send(transportError(frame.id, 'task', 'rate_limited'));
      return;
    }

    let data;
    try {
      // parseTaskIpcData re-verifies HMAC/freshness/replay/scope — a forged,
      // replayed, or cross-folder frame throws here (fail-closed).
      data = parseTaskIpcData(frame.payload, folder);
      assertBoundScopeMatches(
        conn.scope,
        {
          threadId: data.authThreadId ?? data.threadId,
          appId: data.appId,
          agentId: data.agentId,
        },
        'IPC task',
      );
    } catch (err) {
      conn.send(transportError(frame.id, 'task', 'invalid_request'));
      logger.warn({ err, folder }, 'rejected task frame');
      return;
    }

    const taskKey = `task-${data.taskId}`;
    // Register a responder so writeTaskIpcResponse delivers a socket frame.
    registerIpcResponder(folder, taskKey, (signed) => {
      conn.send({
        v: 1,
        type: 'resp',
        channel: 'task',
        id: frame.id,
        payload: signed,
      });
    });

    beginInFlight(conn, taskKey);
    try {
      await processTaskIpc(data, folder, deps, ipcBaseDir);
    } catch (err) {
      // The handler threw before producing a response — clear the responder and
      // surface a transport-level error so the client's pending request settles.
      const pending = takeIpcResponder(folder, taskKey);
      if (pending) {
        conn.send(transportError(frame.id, 'task', 'internal_error'));
      }
      logger.error({ err, folder }, 'task handler threw');
    } finally {
      endInFlight(conn, taskKey);
    }
  }

  async function dispatchMemory(
    frame: IpcWireFrame,
    conn: IpcConnection,
    folder: string,
  ): Promise<void> {
    if (!canProcessIpcFile(folder, 'memory')) {
      // Unsigned transport-level error for the socket rate-limit gate.
      conn.send(transportError(frame.id, 'memory', 'rate_limited'));
      return;
    }

    let request;
    try {
      // parseMemoryIpcRequest re-verifies the memory HMAC/freshness/replay AND
      // re-checks allowedActions — a forged, replayed, or disallowed-action
      // frame throws here (fail-closed); the connection survives.
      request = parseMemoryIpcRequest(frame.payload, folder);
      assertBoundScopeMatches(
        conn.scope,
        {
          threadId: request.context?.threadId,
          appId: request.context?.appId,
          agentId: request.context?.agentId,
        },
        'memory IPC',
      );
    } catch (err) {
      conn.send(transportError(frame.id, 'memory', 'invalid_request'));
      logger.warn({ err, folder }, 'rejected memory frame');
      return;
    }

    const memoryKey = `memory-${request.requestId}`;
    const threadId = request.context?.threadId;
    // Register a responder so writeMemoryResponse delivers a socket frame.
    registerIpcResponder(folder, memoryKey, (signed) => {
      conn.send({
        v: 1,
        type: 'resp',
        channel: 'memory',
        id: frame.id,
        payload: signed,
      });
    });

    beginInFlight(conn, memoryKey);
    try {
      const response = await processMemoryRequest(
        {
          requestId: request.requestId,
          action: request.action,
          payload: request.payload || {},
          allowedActions: request.allowedActions,
          ...(request.deadlineAtMs
            ? { deadlineAtMs: request.deadlineAtMs }
            : {}),
          ...(request.context ? { context: request.context } : {}),
        },
        folder,
      );
      writeMemoryResponse(
        folder,
        request.requestId,
        response,
        getIpcResponseSigningPrivateKey(
          folder,
          threadId,
          request.responseKeyId,
        ),
      );
    } catch (err) {
      // The handler threw before producing a response — clear the responder and
      // surface a transport-level error so the client's pending request settles.
      const pending = takeIpcResponder(folder, memoryKey);
      if (pending) {
        conn.send(transportError(frame.id, 'memory', 'internal_error'));
      }
      logger.error({ err, folder }, 'memory handler threw');
    } finally {
      endInFlight(conn, memoryKey);
    }
  }

  /**
   * The default JID owned by `folder` — the first conversation route bound to
   * it. The child normally stamps the asking conversation's jid, so this is a
   * defensive default when a frame omits `targetJid`.
   */
  function folderDefaultJid(folder: string): string | undefined {
    for (const [jid, route] of Object.entries(deps.conversationRoutes())) {
      if (route.folder === folder) return jid;
    }
    return undefined;
  }

  async function dispatchUserQuestion(
    frame: IpcWireFrame,
    conn: IpcConnection,
    folder: string,
  ): Promise<void> {
    if (!canProcessIpcFile(folder, 'user-question')) {
      // Unsigned transport-level error for the socket rate-limit gate.
      conn.send(transportError(frame.id, 'user_question', 'rate_limited'));
      return;
    }

    let request;
    try {
      // parseUserQuestionIpcRequest re-verifies the HMAC/freshness/replay — a
      // forged, replayed, or malformed frame throws here (fail-closed); the
      // connection survives.
      request = parseUserQuestionIpcRequest(frame.payload, folder);
      assertBoundScopeMatches(
        conn.scope,
        {
          threadId: request.threadId,
          appId: request.appId,
          agentId: request.agentId,
        },
        'user question IPC',
      );
    } catch (err) {
      conn.send(transportError(frame.id, 'user_question', 'invalid_request'));
      logger.warn({ err, folder }, 'rejected user_question frame');
      return;
    }

    // Cross-conversation routing: keep the asking conversation's jid (stamped by
    // the child and preserved by the parser); fall back to the folder default
    // only when absent.
    request.targetJid = request.targetJid || folderDefaultJid(folder);

    const userqKey = `userq-${request.requestId}`;
    const threadId = request.threadId;
    // Register a responder so writeUserQuestionIpcResponse and the failure path
    // deliver socket frames.
    registerIpcResponder(folder, userqKey, (signed) => {
      conn.send({
        v: 1,
        type: 'resp',
        channel: 'user_question',
        id: frame.id,
        payload: signed,
      });
    });

    // Honour the shared interaction in-flight cap + duplicate guard so a
    // request already in flight is not processed twice and the global cap of 100
    // is enforced.
    const inFlightKey = interactionInFlightKey({
      sourceAgentFolder: folder,
      kind: 'user-question',
      ...(threadId ? { threadId } : {}),
      requestId: request.requestId,
    });
    const admission = tryAdmitInteractionInFlight(inFlightKey);
    if (!admission.ok) {
      // Emit a signed empty-answers failure response through the registered
      // responder so the child's pending request settles.
      writeUserQuestionInteractionFailure({
        ipcBaseDir,
        sourceAgentFolder: folder,
        requestId: request.requestId,
        ...(threadId ? { threadId } : {}),
        ...(request.responseKeyId
          ? { responseKeyId: request.responseKeyId }
          : {}),
        logger,
      });
      // If the failure writer was fail-closed (no signing key) the responder is
      // still registered; clear it and settle the request at the transport
      // layer so it does not hang until the client deadline.
      const pending = takeIpcResponder(folder, userqKey);
      if (pending) {
        conn.send(transportError(frame.id, 'user_question', 'busy'));
      }
      return;
    }

    beginInFlight(conn, userqKey);
    try {
      // The handler runs the approval flow and calls the router-aware writer,
      // which delivers the signed response to the responder above. On internal
      // failure it writes the signed empty-answers fallback through the same
      // responder.
      await processUserQuestionInteractionIpc({
        request,
        sourceAgentFolder: folder,
        deps,
        ipcBaseDir,
        logger,
      });
      // Fail-closed guard: if neither the success nor the failure write consumed
      // the responder (e.g. no signing key), settle the request so it does not
      // hang until the client deadline.
      const pending = takeIpcResponder(folder, userqKey);
      if (pending) {
        conn.send(transportError(frame.id, 'user_question', 'internal_error'));
      }
    } catch (err) {
      // processUserQuestionInteractionIpc catches its own errors, but guard the
      // transport regardless: clear any still-registered responder and settle.
      const pending = takeIpcResponder(folder, userqKey);
      if (pending) {
        conn.send(transportError(frame.id, 'user_question', 'internal_error'));
      }
      logger.error({ err, folder }, 'user_question handler threw');
    } finally {
      releaseInteractionInFlight(inFlightKey);
      endInFlight(conn, userqKey);
    }
  }

  /**
   * The set of JIDs owned by `folder` — every conversation route bound to it.
   * A permission request whose stamped targetJid is not in this set is
   * cross-conversation bleed and is rejected.
   */
  function folderOwnedJids(folder: string): Set<string> {
    const owned = new Set<string>();
    for (const [jid, route] of Object.entries(deps.conversationRoutes())) {
      if (route.folder === folder) owned.add(jid);
    }
    return owned;
  }

  async function dispatchPermission(
    frame: IpcWireFrame,
    conn: IpcConnection,
    folder: string,
  ): Promise<void> {
    if (!canProcessIpcFile(folder, 'permission')) {
      // Unsigned transport-level error for the socket rate-limit gate.
      conn.send(transportError(frame.id, 'permission', 'rate_limited'));
      return;
    }

    let request;
    try {
      // parsePermissionIpcRequest re-verifies the HMAC/freshness/replay — a
      // forged, replayed, or malformed frame throws here (fail-closed); the
      // connection survives. An exact byte-identical replay is rejected by the
      // consumed-requestId guard inside this parse, which is also the socket
      // idempotency guarantee against a re-sent permission request.
      request = parsePermissionIpcRequest(frame.payload, folder);
      assertBoundScopeMatches(
        conn.scope,
        {
          threadId: request.threadId,
          appId: request.appId,
          agentId: request.agentId,
        },
        'permission IPC',
      );
    } catch (err) {
      conn.send(transportError(frame.id, 'permission', 'invalid_request'));
      logger.warn({ err, folder }, 'rejected permission frame');
      return;
    }

    const permissionKey = `permission-${request.requestId}`;
    const threadId = request.threadId;
    // Register the responder and reserve the per-connection slot before any
    // awaited validation. That keeps the onFrame cap check effective even when
    // scheduled-job binding validation blocks on repository I/O.
    registerIpcResponder(folder, permissionKey, (signed) => {
      conn.send({
        v: 1,
        type: 'resp',
        channel: 'permission',
        id: frame.id,
        payload: signed,
      });
    });
    beginInFlight(conn, permissionKey);

    // Honour the shared interaction in-flight cap + duplicate guard before any
    // awaited validation so many scheduled-job permission requests cannot all
    // park in repository I/O before consuming interaction capacity.
    const inFlightKey = interactionInFlightKey({
      sourceAgentFolder: folder,
      kind: 'permission',
      ...(threadId ? { threadId } : {}),
      requestId: request.requestId,
    });
    const admission = tryAdmitInteractionInFlight(inFlightKey);
    if (!admission.ok) {
      // Emit a signed denial response through the registered responder so the
      // child's pending request settles.
      writePermissionInteractionFailure({
        ipcBaseDir,
        sourceAgentFolder: folder,
        requestId: request.requestId,
        ...(request.responseNonce
          ? { responseNonce: request.responseNonce }
          : {}),
        ...(threadId ? { threadId } : {}),
        ...(request.responseKeyId
          ? { responseKeyId: request.responseKeyId }
          : {}),
        logger,
      });
      // If the failure writer was fail-closed (no signing key) the responder is
      // still registered; clear it and settle the request at the transport layer
      // so it does not hang until the client deadline.
      const pending = takeIpcResponder(folder, permissionKey);
      if (pending) {
        conn.send(transportError(frame.id, 'permission', 'busy'));
      }
      endInFlight(conn, permissionKey);
      return;
    }

    try {
      // Folder-owns-JID authz: the asking conversation's jid (stamped by the
      // child and preserved by the parser) must belong to this folder.
      if (
        request.targetJid &&
        !folderOwnedJids(folder).has(request.targetJid)
      ) {
        throw new Error(
          'Permission IPC target does not belong to the requesting agent folder',
        );
      }
      // Scheduled-job exec-context binding: when the request carries a jobId,
      // the job's canonical execution_context (folder/jid/thread/run) must match.
      await validatePermissionIpcJobExecutionTarget({
        request,
        sourceAgentFolder: folder,
        deps,
      });
    } catch (err) {
      // Emit a signed denial through the registered responder so binding
      // failures settle the child's pending request as denied.
      writePermissionInteractionFailure({
        ipcBaseDir,
        sourceAgentFolder: folder,
        requestId: request.requestId,
        ...(request.responseNonce
          ? { responseNonce: request.responseNonce }
          : {}),
        ...(request.threadId ? { threadId: request.threadId } : {}),
        ...(request.responseKeyId
          ? { responseKeyId: request.responseKeyId }
          : {}),
        logger,
      });
      const pending = takeIpcResponder(folder, permissionKey);
      if (pending) {
        conn.send(transportError(frame.id, 'permission', 'invalid_request'));
      }
      releaseInteractionInFlight(inFlightKey);
      endInFlight(conn, permissionKey);
      logger.warn({ err, folder }, 'rejected permission frame (binding)');
      return;
    }

    // Cross-conversation routing: keep the stamped jid; fall back to the
    // folder's default jid only when absent.
    request.targetJid = request.targetJid || folderDefaultJid(folder);

    try {
      // The handler runs approval, persistence, and recovery, then calls the
      // router-aware writer. On internal failure it writes the signed denial
      // fallback through the same responder.
      await processPermissionInteractionIpc({
        request,
        sourceAgentFolder: folder,
        deps,
        ipcBaseDir,
        logger,
      });
      // Fail-closed guard: if neither the success nor the failure write consumed
      // the responder (e.g. no signing key), settle the request so it does not
      // hang until the client deadline.
      const pending = takeIpcResponder(folder, permissionKey);
      if (pending) {
        conn.send(transportError(frame.id, 'permission', 'internal_error'));
      }
    } catch (err) {
      // processPermissionInteractionIpc catches its own errors, but guard the
      // transport regardless: clear any still-registered responder and settle.
      const pending = takeIpcResponder(folder, permissionKey);
      if (pending) {
        conn.send(transportError(frame.id, 'permission', 'internal_error'));
      }
      logger.error({ err, folder }, 'permission handler threw');
    } finally {
      releaseInteractionInFlight(inFlightKey);
      endInFlight(conn, permissionKey);
    }
  }

  async function dispatchBrowser(
    frame: IpcWireFrame,
    conn: IpcConnection,
    folder: string,
  ): Promise<void> {
    let request;
    try {
      // parseBrowserIpcRequest re-verifies the chat-scoped browser HMAC token,
      // freshness, and replay (and requires context.chatJid) — a forged,
      // replayed, or malformed frame throws here (fail-closed); the connection
      // survives. The chatJid binding the parser enforces is what scopes the
      // browser grant + the cross-conversation profile below.
      request = parseBrowserIpcRequest(frame.payload, folder);
      assertBoundScopeMatches(
        conn.scope,
        {
          threadId: request.threadId,
          appId: request.appId,
          agentId: request.agentId,
        },
        'browser IPC',
      );
    } catch (err) {
      conn.send(transportError(frame.id, 'browser', 'invalid_request'));
      logger.warn({ err, folder }, 'rejected browser frame');
      return;
    }

    // Resolve the browser grant by (folder, chatJid, threadId), so the parser's
    // verified chatJid binds the grant to the asking conversation.
    const browserIpcAuthorized = isBrowserIpcAuthorized({
      workspaceKey: folder,
      chatJid: request.chatJid,
      threadId: request.threadId,
    });

    // Rate-limit gate: only an authorized request is metered against the
    // (folder,'browser') bucket. An unauthorized request is not charged; the
    // handler returns the unauthorized error.
    if (browserIpcAuthorized && !canProcessIpcFile(folder, 'browser')) {
      conn.send(transportError(frame.id, 'browser', 'rate_limited'));
      return;
    }

    const browserKey = `browser-${request.requestId}`;
    // Register a responder so writeBrowserIpcResponse and the cap-exceeded path
    // deliver socket frames.
    registerIpcResponder(folder, browserKey, (signed) => {
      conn.send({
        v: 1,
        type: 'resp',
        channel: 'browser',
        id: frame.id,
        payload: signed,
      });
    });

    // Honour the shared browser in-flight cap (4). When the cap is hit, emit the
    // signed "failed to process" response through the registered responder so
    // the child's pending request settles.
    if (!tryAcquireBrowserInFlight()) {
      writeBrowserFailureResponse({
        ipcBaseDir,
        sourceAgentFolder: folder,
        requestId: request.requestId,
        ...(request.threadId ? { authThreadId: request.threadId } : {}),
        ...(request.responseKeyId
          ? { responseKeyId: request.responseKeyId }
          : {}),
        logger,
      });
      // If the failure writer was fail-closed (no signing key) the responder is
      // still registered; clear it and settle at the transport layer so the
      // request does not hang until the client deadline.
      const pending = takeIpcResponder(folder, browserKey);
      if (pending) {
        conn.send(transportError(frame.id, 'browser', 'busy'));
      }
      return;
    }

    beginInFlight(conn, browserKey);
    try {
      // The handler runs the backend + browser grant lifecycle and calls the
      // router-aware writer. On internal failure it writes the signed "failed to
      // process" fallback through the same responder.
      await runBrowserIpcRequest({
        request,
        sourceAgentFolder: folder,
        browserIpcAuthorized,
        ipcBaseDir,
        deps,
        logger,
      });
      // Fail-closed guard: if neither the success nor the failure write consumed
      // the responder (e.g. no signing key), settle the request so it does not
      // hang until the client deadline.
      const pending = takeIpcResponder(folder, browserKey);
      if (pending) {
        conn.send(transportError(frame.id, 'browser', 'internal_error'));
      }
    } catch (err) {
      // runBrowserIpcRequest catches its own errors, but guard the transport
      // regardless: clear any still-registered responder and settle.
      const pending = takeIpcResponder(folder, browserKey);
      if (pending) {
        conn.send(transportError(frame.id, 'browser', 'internal_error'));
      }
      logger.error({ err, folder }, 'browser handler threw');
    } finally {
      releaseBrowserInFlight();
      endInFlight(conn, browserKey);
    }
  }

  // -------------------------------------------------------------------------
  // onFrame
  // -------------------------------------------------------------------------
  function onFrame(frame: IpcWireFrame, conn: IpcConnection): void {
    // Not yet handshaked: the only acceptable frame is ctrl:hello.
    if (conn.scope === undefined) {
      if (frame.type !== 'ctrl' || frame.ctrl !== 'hello') {
        conn.destroy('expected_hello');
        return;
      }
      const result = validateHello(frame.payload);
      if ('reason' in result) {
        logger.warn({ reason: result.reason }, 'IPC handshake rejected');
        conn.destroy('handshake_rejected');
        return;
      }
      conn.bindScope(result.scope);
      const st = state.get(conn);
      if (st?.handshakeTimer) {
        clearTimeout(st.handshakeTimer);
        st.handshakeTimer = undefined;
      }
      const folder = result.scope.sourceAgentFolder;
      let set = byFolder.get(folder);
      if (!set) {
        set = new Set<IpcConnection>();
        byFolder.set(folder, set);
      }
      set.add(conn);
      conn.send({
        v: 1,
        type: 'ctrl',
        channel: null,
        ctrl: 'welcome',
        id: frame.id,
        payload: {},
      });
      sendCurrentLiveToolRules(conn);
      conn.startHeartbeat();
      return;
    }

    // Handshaked.
    if (frame.type === 'req') {
      if (!isSupportedRequestChannel(frame.channel)) {
        conn.send(
          transportError(frame.id, frame.channel, 'unsupported_channel'),
        );
        return;
      }
      if (!roleCanSendRequest(conn.scope.role, frame.channel)) {
        conn.send(
          transportError(frame.id, frame.channel, 'unauthorized_channel_role'),
        );
        return;
      }
      const st = state.get(conn);
      if (st && st.inFlight >= maxInFlight) {
        // Backpressure: refuse the request and signal busy (D6).
        conn.send(transportError(frame.id, frame.channel, 'busy'));
        conn.send({
          v: 1,
          type: 'ctrl',
          channel: null,
          ctrl: 'busy',
          id: frame.id,
          payload: {},
        });
        return;
      }
      void dispatchRequest(frame, conn);
      return;
    }

    if (
      frame.type === 'ctrl' &&
      (frame.ctrl === 'drain' || frame.ctrl === 'close')
    ) {
      // Full drain semantics are a later phase; for now just close.
      conn.destroy('peer_closed');
      return;
    }

    // resp/push from a worker, or any other unexpected frame: typed reject and
    // keep the connection alive. This mirrors malformed-frame behavior at the
    // protocol layer without letting one bad frame poison the whole stream.
    logger.debug(
      { type: frame.type, channel: frame.channel },
      'ignoring unexpected frame from worker',
    );
    conn.send(transportError(frame.id, frame.channel, 'unexpected_frame_type'));
  }

  // -------------------------------------------------------------------------
  // onClose
  // -------------------------------------------------------------------------
  function onClose(_reason: string, conn: IpcConnection): void {
    connections.delete(conn);
    const st = state.get(conn);
    if (st?.handshakeTimer) {
      clearTimeout(st.handshakeTimer);
      st.handshakeTimer = undefined;
    }
    const folder = conn.scope?.sourceAgentFolder;
    if (folder) {
      const set = byFolder.get(folder);
      if (set) {
        set.delete(conn);
        if (set.size === 0) byFolder.delete(folder);
      }
    }
    // Purge any single-shot responder still registered for this connection's
    // in-flight requests and release their in-flight slots. The connection's
    // pending client-side requests are already rejected `connection_lost` by the
    // client; on the server side a handler that resolves AFTER the drop would
    // otherwise call the responder (conn.send is a no-op on a closed connection,
    // so harmless) or leave the entry leaked in the router. Taking it here makes
    // the drop self-healing: the slot frees (the per-connection cap recovers) and
    // no responder can later deliver to — or leak past — a dead connection. A
    // worker that retries with the SAME requestId is still rejected by the
    // consumed-id replay set (the handler ran at most once), so this purge cannot
    // cause double-execution.
    if (st && folder) {
      for (const key of st.responderKeys) {
        takeIpcResponder(folder, key);
      }
      st.responderKeys.clear();
      st.inFlight = 0;
    }
    if (conn.scope?.role === 'runner') {
      revokeIpcResponseSigningKey(
        conn.scope.responseKeyId ?? undefined,
        conn.scope.sourceAgentFolder,
        conn.scope.threadId,
      );
    }
  }

  function onError(err: Error, conn: IpcConnection): void {
    logger.warn(
      { err, folder: conn.scope?.sourceAgentFolder },
      'IPC connection error',
    );
  }

  function onInvalidFrame(
    err: IpcWireError,
    raw: Record<string, unknown> | undefined,
    conn: IpcConnection,
  ): void {
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : undefined;
    if (!id || id.length > 128) return;
    const channel = isIpcWireChannel(raw?.channel) ? raw.channel : null;
    conn.send(transportError(id, channel, err.reason));
  }

  // -------------------------------------------------------------------------
  // onConnection
  // -------------------------------------------------------------------------
  function onConnection(socket: net.Socket): void {
    if (opts.peerUidProvider && typeof expectedPeerUid === 'number') {
      let peerUid: number | undefined;
      try {
        peerUid = opts.peerUidProvider(socket);
      } catch (err) {
        logger.warn({ err }, 'IPC peer uid check failed');
        socket.destroy();
        return;
      }
      if (typeof peerUid === 'number' && peerUid !== expectedPeerUid) {
        logger.warn(
          { peerUid, expectedPeerUid },
          'IPC peer uid mismatch; closing connection',
        );
        socket.destroy();
        return;
      }
    }
    const conn = new IpcConnection({
      socket,
      maxBytes: IPC_FRAME_MAX_BYTES,
      heartbeatIntervalMs: IPC_HEARTBEAT_INTERVAL_MS,
      onFrame,
      onClose,
      onError,
      onInvalidFrame,
    });
    const handshakeTimer = setTimeout(() => {
      if (conn.scope === undefined && !conn.closed) {
        conn.destroy('handshake_timeout');
      }
    }, handshakeTimeoutMs);
    if (
      typeof handshakeTimer === 'object' &&
      handshakeTimer !== null &&
      'unref' in handshakeTimer
    ) {
      (handshakeTimer as { unref(): void }).unref();
    }
    state.set(conn, {
      handshakeTimer,
      inFlight: 0,
      responderKeys: new Set<string>(),
    });
    connections.add(conn);
  }

  // -------------------------------------------------------------------------
  // Bind
  // -------------------------------------------------------------------------
  const outcome = await bindIpcSocket({ socketPath, onConnection });
  if (!outcome.ok) {
    unsubscribeLiveToolRules();
    // Another core owns the socket (single instance) — do NOT throw.
    logger.info(
      { socketPath, reason: outcome.reason },
      'IPC socket server not started (socket already owned)',
    );
    return undefined;
  }
  const bound: SocketBindResult = outcome.bound;

  async function stop(): Promise<void> {
    unsubscribeLiveToolRules();
    for (const conn of [...connections]) {
      if (conn.scope?.role === 'runner') {
        conn.send({
          v: 1,
          type: 'ctrl',
          channel: null,
          ctrl: 'drain',
          id: randomUUID(),
          payload: {},
        });
      }
      conn.end('server_stopping');
    }
    connections.clear();
    byFolder.clear();
    await releaseIpcSocket(bound);
  }

  return {
    socketPath,
    stop,
    connectionsForFolder(folder: string): IpcConnection[] {
      const set = byFolder.get(folder);
      return set ? [...set] : [];
    },
  };
}
