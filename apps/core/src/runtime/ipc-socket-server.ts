import path from 'path';
import type net from 'net';

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
import { parseIpcMessage, parseMemoryIpcRequest } from './ipc-parsing.js';
import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import { processTaskIpc } from '../jobs/ipc-handler.js';
import {
  processMemoryRequest,
  writeMemoryResponse,
} from '../memory/memory-ipc.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { type IpcWireChannel, type IpcWireFrame } from '../shared/ipc-wire.js';

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
    payload: { ok: false, code },
  };
}

function coerceOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

  const connections = new Set<IpcConnection>();
  const byFolder = new Map<string, Set<IpcConnection>>();
  const state = new WeakMap<IpcConnection, ConnState>();

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

    if (channel === 'message') {
      // Fire-and-forget; no response frame.
      if (!canProcessIpcFile(folder, 'messages')) {
        logger.warn({ folder }, 'IPC message rate-limited');
        return;
      }
      let data;
      try {
        data = parseIpcMessage(frame.payload, folder);
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

    // browser/permission/user_question/etc. are cut over in a later phase by
    // making their writers router-aware. Until then: explicit reject.
    conn.send(transportError(frame.id, channel, 'unsupported_channel'));
  }

  async function dispatchTask(
    frame: IpcWireFrame,
    conn: IpcConnection,
    folder: string,
  ): Promise<void> {
    if (!canProcessIpcFile(folder, 'tasks')) {
      // Unsigned transport-level error: the client treats an error resp as a
      // failed request, mirroring writeTaskIpcResponse({ok:false}) which the fs
      // path also emits unsigned in some error cases.
      conn.send(transportError(frame.id, 'task', 'rate_limited'));
      return;
    }

    let data;
    try {
      // parseTaskIpcData re-verifies HMAC/freshness/replay/scope — a forged,
      // replayed, or cross-folder frame throws here (fail-closed).
      data = parseTaskIpcData(frame.payload, folder);
    } catch (err) {
      conn.send(transportError(frame.id, 'task', 'invalid_request'));
      logger.warn({ err, folder }, 'rejected task frame');
      return;
    }

    const taskKey = `task-${data.taskId}`;
    // Register a responder so the existing handler's writeTaskIpcResponse is
    // delivered as a frame instead of a file write.
    registerIpcResponder(folder, taskKey, (signed) => {
      conn.send({
        v: 1,
        type: 'resp',
        channel: 'task',
        id: frame.id,
        payload: signed,
      });
    });

    const st = state.get(conn);
    if (st) st.inFlight += 1;
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
      const after = state.get(conn);
      if (after && after.inFlight > 0) after.inFlight -= 1;
    }
  }

  async function dispatchMemory(
    frame: IpcWireFrame,
    conn: IpcConnection,
    folder: string,
  ): Promise<void> {
    if (!canProcessIpcFile(folder, 'memory')) {
      // Unsigned transport-level error mirroring the fs path's rate-limit drop.
      conn.send(transportError(frame.id, 'memory', 'rate_limited'));
      return;
    }

    let request;
    try {
      // parseMemoryIpcRequest re-verifies the memory HMAC/freshness/replay AND
      // re-checks allowedActions — a forged, replayed, or disallowed-action
      // frame throws here (fail-closed); the connection survives.
      request = parseMemoryIpcRequest(frame.payload, folder);
    } catch (err) {
      conn.send(transportError(frame.id, 'memory', 'invalid_request'));
      logger.warn({ err, folder }, 'rejected memory frame');
      return;
    }

    const memoryKey = `memory-${request.requestId}`;
    const threadId = request.context?.threadId;
    // Register a responder so the handler's writeMemoryResponse is delivered as
    // a frame instead of a memory-responses/<requestId>.json file write.
    registerIpcResponder(folder, memoryKey, (signed) => {
      conn.send({
        v: 1,
        type: 'resp',
        channel: 'memory',
        id: frame.id,
        payload: signed,
      });
    });

    const st = state.get(conn);
    if (st) st.inFlight += 1;
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
      const after = state.get(conn);
      if (after && after.inFlight > 0) after.inFlight -= 1;
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
      conn.startHeartbeat();
      return;
    }

    // Handshaked.
    if (frame.type === 'req') {
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

    // resp/push from a worker, or any other unexpected frame: log + ignore.
    logger.debug(
      { type: frame.type, channel: frame.channel },
      'ignoring unexpected frame from worker',
    );
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
    // NOTE (later phase): revoke this connection's ed25519 response signing key
    // here so an orphaned/duplicate response cannot be delivered after drop.
  }

  function onError(err: Error, conn: IpcConnection): void {
    logger.warn(
      { err, folder: conn.scope?.sourceAgentFolder },
      'IPC connection error',
    );
  }

  // -------------------------------------------------------------------------
  // onConnection
  // -------------------------------------------------------------------------
  function onConnection(socket: net.Socket): void {
    const conn = new IpcConnection({
      socket,
      maxBytes: IPC_FRAME_MAX_BYTES,
      heartbeatIntervalMs: IPC_HEARTBEAT_INTERVAL_MS,
      onFrame,
      onClose,
      onError,
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
    state.set(conn, { handshakeTimer, inFlight: 0 });
    connections.add(conn);
  }

  // -------------------------------------------------------------------------
  // Bind
  // -------------------------------------------------------------------------
  const outcome = await bindIpcSocket({ socketPath, onConnection });
  if (!outcome.ok) {
    // Another core owns the socket (single instance) — do NOT throw.
    logger.info(
      { socketPath, reason: outcome.reason },
      'IPC socket server not started (socket already owned)',
    );
    return undefined;
  }
  const bound: SocketBindResult = outcome.bound;

  async function stop(): Promise<void> {
    for (const conn of connections) {
      conn.destroy('server_stopping');
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
