import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// processTaskIpc is mocked so the test drives EXACTLY what the task handler does
// — most importantly, WHEN it resolves. The failure-injection cases hinge on a
// handler that is still pending (or resolves AFTER the connection is gone), so a
// controllable mock is essential. The success paths call the REAL
// writeTaskIpcResponse, exercising the response-router → signed-resp-frame path
// end to end (identical to ipc-socket-transport.test.ts).
vi.mock('@core/jobs/ipc-handler.js', () => ({
  processTaskIpc: vi.fn(),
}));

import { processTaskIpc } from '@core/jobs/ipc-handler.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import {
  startIpcSocketServer,
  type IpcSocketServerHandle,
} from '@core/runtime/ipc-socket-server.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { createSignedIpcRequestEnvelope } from '@core/runner/mcp/signing.js';
import { encodeFrame, FrameDecoder } from '@core/shared/ipc-frame.js';
import {
  encodeWireFrame,
  parseWireFrame,
  type IpcWireFrame,
  type IpcWireChannel,
} from '@core/shared/ipc-wire.js';
import {
  clearIpcResponders,
  hasIpcResponder,
} from '@core/runtime/ipc-response-router.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { clearIpcRateLimitState } from '@core/runtime/ipc-rate-limit.js';
import {
  IpcSocketClient,
  IpcRequestError,
} from '@core/shared/ipc-socket-client.js';

const processTaskIpcMock = vi.mocked(processTaskIpc);

// ---------------------------------------------------------------------------
// Fixtures (mirrors ipc-socket-transport.test.ts)
// ---------------------------------------------------------------------------

const FOLDER = 'group-test';
const CHAT_JID = 'wa:1555000@test';
const THREAD_ID = 'thread-abc';

function buildDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  const routes: Record<string, ConversationRoute> = {
    [CHAT_JID]: {
      name: 'Test Group',
      folder: FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    },
  };
  const deps = {
    sendMessage: vi.fn(async () => undefined),
    conversationRoutes: () => routes,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => undefined),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onSchedulerChanged: vi.fn(),
    requestPermissionApproval: vi.fn(async () => ({}) as never),
    requestUserAnswer: vi.fn(async () => ({}) as never),
    opsRepository: {} as never,
    ...overrides,
  } as unknown as IpcDeps;
  return deps;
}

function makeAuth(folder: string, threadId: string | undefined) {
  return createIpcAuthEnvelope(folder, threadId);
}

function buildHelloPayload(
  authToken: string,
  opts: { folder: string; threadId?: string },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    kind: 'hello',
    role: 'runner',
    runHandle: 'run-1',
    folder: opts.folder,
    context: { threadId: opts.threadId ?? null },
  });
}

function buildTaskPayload(
  authToken: string,
  responseKeyId: string,
  opts: { taskId: string; type?: string; threadId?: string },
): Record<string, unknown> {
  // The auth token is bound to THREAD_ID (the handshake thread), so the payload
  // must carry the same thread or validateIpcAuthRequest recomputes a different
  // signing key and the signature fails. Every case in this file runs on the
  // single THREAD_ID, so it is the default here.
  const threadId = opts.threadId ?? THREAD_ID;
  return createSignedIpcRequestEnvelope(authToken, {
    type: opts.type ?? 'scheduler_list_jobs',
    taskId: opts.taskId,
    context: {
      threadId,
      responseKeyId,
    },
  });
}

// ---------------------------------------------------------------------------
// Fake worker client — real net.connect, framed wire protocol, precise control
// over WHEN bytes are sent and WHEN the socket is destroyed. Ported from
// ipc-socket-transport.test.ts (only the bits these cases need).
// ---------------------------------------------------------------------------

class FakeWorkerClient {
  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly inbound: IpcWireFrame[] = [];
  private waiters: Array<(frame: IpcWireFrame) => void> = [];
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      let bodies: Buffer[];
      try {
        bodies = this.decoder.push(chunk);
      } catch {
        return;
      }
      for (const body of bodies) {
        let frame: IpcWireFrame;
        try {
          frame = parseWireFrame(body.toString('utf8'));
        } catch {
          continue;
        }
        if (frame.type === 'ctrl' && frame.ctrl === 'ping') {
          this.sendRaw({
            v: 1,
            type: 'ctrl',
            channel: null,
            ctrl: 'pong',
            id: frame.id,
            payload: {},
          });
          continue;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.inbound.push(frame);
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
  }

  static connect(socketPath: string): Promise<FakeWorkerClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const onErr = (err: Error) => reject(err);
      socket.once('error', onErr);
      socket.once('connect', () => {
        socket.removeListener('error', onErr);
        resolve(new FakeWorkerClient(socket));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  sendRaw(frame: IpcWireFrame): void {
    const body = Buffer.from(encodeWireFrame(frame), 'utf8');
    this.socket.write(encodeFrame(body));
  }

  sendHello(signedPayload: Record<string, unknown>, id = 'hello-1'): void {
    this.sendRaw({
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'hello',
      id,
      payload: signedPayload,
    });
  }

  sendReq(
    channel: IpcWireChannel,
    signedPayload: Record<string, unknown>,
    id: string,
  ): void {
    this.sendRaw({ v: 1, type: 'req', channel, id, payload: signedPayload });
  }

  nextFrame(timeoutMs = 5000): Promise<IpcWireFrame> {
    const buffered = this.inbound.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onFrame);
        reject(new Error('nextFrame timeout'));
      }, timeoutMs);
      const onFrame = (frame: IpcWireFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(onFrame);
    });
  }

  async waitForId(id: string, timeoutMs = 5000): Promise<IpcWireFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`waitForId(${id}) timeout`);
      const frame = await this.nextFrame(remaining);
      if (frame.id === id) return frame;
    }
  }

  /** Throws if any frame matching `id` arrives within the window (it must NOT). */
  async expectNoFrameForId(id: string, windowMs = 250): Promise<void> {
    const deadline = Date.now() + windowMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let frame: IpcWireFrame;
      try {
        frame = await this.nextFrame(remaining);
      } catch {
        return; // timed out with no frame → good
      }
      if (frame.id === id) {
        throw new Error(`unexpected frame for id ${id}`);
      }
    }
  }

  waitClose(timeoutMs = 5000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('waitClose timeout')),
        timeoutMs,
      );
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let server: IpcSocketServerHandle | undefined;
const fakeClients: FakeWorkerClient[] = [];
const realClients: IpcSocketClient[] = [];

function socketPathFor(name = 'core.sock'): string {
  return path.join(tmpDir, name);
}

/** Poll until `predicate()` is true or the deadline passes. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error('waitFor timeout');
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-socket-failure-'));
  processTaskIpcMock.mockReset();
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
});

afterEach(async () => {
  for (const c of realClients.splice(0)) c.close();
  for (const c of fakeClients.splice(0)) c.destroy();
  if (server) {
    await server.stop().catch(() => undefined);
    server = undefined;
  }
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function startServer(
  deps: IpcDeps,
  opts: Parameters<typeof startIpcSocketServer>[1] = {},
): Promise<IpcSocketServerHandle> {
  const handle = await startIpcSocketServer(deps, {
    socketPath: socketPathFor(),
    ...opts,
  });
  if (!handle) throw new Error('server failed to start');
  server = handle;
  return handle;
}

async function connectFake(
  handle: IpcSocketServerHandle,
): Promise<FakeWorkerClient> {
  const client = await FakeWorkerClient.connect(handle.socketPath);
  fakeClients.push(client);
  return client;
}

async function handshakeFake(
  handle: IpcSocketServerHandle,
  auth: ReturnType<typeof makeAuth>,
  threadId = THREAD_ID,
): Promise<FakeWorkerClient> {
  const client = await connectFake(handle);
  client.sendHello(
    buildHelloPayload(auth.authToken, { folder: FOLDER, threadId }),
    'hs',
  );
  const welcome = await client.waitForId('hs');
  expect(welcome.ctrl).toBe('welcome');
  return client;
}

// ===========================================================================
// 1. Drop BEFORE handshake → server cleans up; a later client can connect.
// ===========================================================================

describe('ipc-socket failure injection', () => {
  it('1. drop before handshake → connection cleaned up, no leak, later client connects', async () => {
    const handle = await startServer(buildDeps());

    // Connect raw, send NOTHING, drop immediately (before any hello).
    const dropped = await connectFake(handle);
    dropped.destroy();
    await dropped.waitClose();

    // Nothing was ever bound to the folder.
    expect(handle.connectionsForFolder(FOLDER).length).toBe(0);

    // A later client can still connect + handshake on the same server.
    const auth = makeAuth(FOLDER, THREAD_ID);
    const later = await handshakeFake(handle, auth);
    expect(later.isClosed).toBe(false);
    await waitFor(() => handle.connectionsForFolder(FOLDER).length === 1);
  });

  // =========================================================================
  // 2. Drop right after handshake (before any request) → removed from
  //    connectionsForFolder.
  // =========================================================================

  it('2. drop right after handshake (before any request) → removed from connectionsForFolder', async () => {
    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshakeFake(handle, auth);

    expect(handle.connectionsForFolder(FOLDER).length).toBe(1);

    client.destroy();
    await client.waitClose();

    // onClose removes it from the folder index.
    await waitFor(() => handle.connectionsForFolder(FOLDER).length === 0);
  });

  // =========================================================================
  // 3. Drop MID-REQUEST → slot freed (cap recovers) + responder purged.
  //    The handler never resolves; the client is destroyed while the request
  //    is in flight. Without the onClose slot-free + responder-purge this
  //    leaks the in-flight slot forever and leaves the responder dangling.
  // =========================================================================

  it('3. drop mid-request → in-flight slot freed (cap recovers) and responder purged', async () => {
    // A handler that NEVER resolves while in flight: it parks until the test
    // releases it. The first (mid-flight-dropped) request stays pending.
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolveStarted) => {
      processTaskIpcMock.mockImplementationOnce(async () => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      });
    });

    const maxInFlight = 3;
    const handle = await startServer(buildDeps(), {
      maxInFlightPerConnection: maxInFlight,
    });
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshakeFake(handle, auth);

    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-stuck',
      }),
      'req-stuck',
    );

    // Wait until the handler is actually running (slot taken, responder live).
    await firstStarted;
    expect(hasIpcResponder(FOLDER, 'task-task-stuck')).toBe(true);

    // Drop the connection while the request is still in flight.
    client.destroy();
    await client.waitClose();

    // onClose must purge the responder and free the slot.
    await waitFor(() => !hasIpcResponder(FOLDER, 'task-task-stuck'));
    await waitFor(() => handle.connectionsForFolder(FOLDER).length === 0);

    // Release the stuck handler AFTER the drop: writeTaskIpcResponse finds no
    // responder (purged) so it would fall back to a file write — there is no
    // live connection to deliver to, and crucially no crash.
    let releasedOk = true;
    try {
      releaseFirst?.();
      // Let the parked handler unwind.
      await new Promise((r) => setTimeout(r, 20));
    } catch {
      releasedOk = false;
    }
    expect(releasedOk).toBe(true);

    // Cap fully recovered: a FRESH connection can run `maxInFlight` concurrent
    // requests. We park all of them, assert the (maxInFlight+1)th is refused
    // busy, then release them all and confirm each settles ok.
    const releasers: Array<() => void> = [];
    processTaskIpcMock.mockImplementation(async (data) => {
      await new Promise<void>((resolve) => {
        releasers.push(resolve);
      });
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'done' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    const fresh = await handshakeFake(handle, auth);
    for (let i = 0; i < maxInFlight; i += 1) {
      fresh.sendReq(
        'task',
        buildTaskPayload(auth.authToken, auth.responseKeyId, {
          taskId: `task-cap-${i}`,
        }),
        `req-cap-${i}`,
      );
    }
    // All `maxInFlight` handlers must be running concurrently → cap recovered.
    await waitFor(() => releasers.length === maxInFlight);

    // One more request is over the cap → busy.
    fresh.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-cap-over',
      }),
      'req-cap-over',
    );
    const over = await fresh.waitForId('req-cap-over');
    expect((over.payload as { ok?: boolean }).ok).toBe(false);
    expect((over.payload as { code?: string }).code).toBe('busy');

    // Release the parked handlers; each settles ok.
    for (const release of releasers) release();
    for (let i = 0; i < maxInFlight; i += 1) {
      const resp = await fresh.waitForId(`req-cap-${i}`);
      expect((resp.payload as { ok?: boolean }).ok).toBe(true);
    }
  });

  // =========================================================================
  // 4. Drop AFTER request, BEFORE response → handler resolves after the
  //    connection is gone → writeTaskIpcResponse routes to a responder whose
  //    conn.send is a no-op on the closed connection → no crash, harmlessly
  //    dropped, slot freed.
  //
  //    (Distinct from case 3: here the responder is NOT purged before the
  //    handler resolves — we release the handler the instant the drop lands,
  //    racing the resolution against onClose so the responder.send path on a
  //    closed connection is exercised.)
  // =========================================================================

  it('4. drop after request before response → late response harmlessly dropped, no crash, slot freed', async () => {
    let releaseHandler: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolveStarted) => {
      processTaskIpcMock.mockImplementationOnce(async (data) => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        // Resolve the response AFTER the connection has been destroyed: the
        // responder's conn.send is a no-op on a closed connection.
        writeTaskIpcResponse(
          FOLDER,
          data.taskId,
          { ok: true, message: 'late' },
          data.authThreadId,
          data.responseKeyId,
        );
      });
    });

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshakeFake(handle, auth);

    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-orphan',
      }),
      'req-orphan',
    );

    await handlerStarted;

    // Drop, then immediately release the handler so its writeTaskIpcResponse
    // runs against the now-closing connection.
    client.destroy();
    releaseHandler?.();

    // No crash; the connection is cleaned up and the slot freed.
    await client.waitClose();
    await waitFor(() => handle.connectionsForFolder(FOLDER).length === 0);
    // Whether onClose purged it first or the handler consumed it, the responder
    // must not linger.
    await waitFor(() => !hasIpcResponder(FOLDER, 'task-task-orphan'));

    // Server still fully functional: a fresh connection gets a real response.
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'ok' },
        data.authThreadId,
        data.responseKeyId,
      );
    });
    const fresh = await handshakeFake(handle, auth);
    fresh.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-after',
      }),
      'req-after',
    );
    const ok = await fresh.waitForId('req-after');
    expect((ok.payload as { ok?: boolean }).ok).toBe(true);
  });

  // =========================================================================
  // 5. Core restart mid-conversation → stop() the server, start a fresh one on
  //    the same socket path; a reconnecting client re-handshakes and a NEW
  //    request succeeds. The stale socket is reclaimed (election) and there is
  //    no double-processing.
  // =========================================================================

  it('5. core restart mid-conversation → client reconnects, re-handshakes, new request succeeds; stale socket reclaimed', async () => {
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'served' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    const socketPath = socketPathFor();
    const auth = makeAuth(FOLDER, THREAD_ID);

    const handle1 = await startIpcSocketServer(buildDeps(), { socketPath });
    if (!handle1) throw new Error('server1 failed to start');
    server = handle1;

    // Real reconnecting client.
    const client = new IpcSocketClient({
      socketPath,
      buildHello: () =>
        buildHelloPayload(auth.authToken, {
          folder: FOLDER,
          threadId: THREAD_ID,
        }),
      reconnect: {
        enabled: true,
        baseDelayMs: 5,
        maxDelayMs: 20,
      },
      randomFn: () => 1,
    });
    realClients.push(client);
    await client.connect();
    expect(client.connected).toBe(true);

    // First request on the original server succeeds.
    const first = await client.request(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-before-restart',
      }),
    );
    expect(first.ok).toBe(true);

    // "Restart": stop the server (drops the client), then start a fresh one on
    // the SAME socket path. The fresh bind must reclaim the (now stale) socket.
    await handle1.stop();
    await waitFor(() => client.connected === false);

    const handle2 = await startIpcSocketServer(buildDeps(), { socketPath });
    if (!handle2) throw new Error('server2 failed to reclaim the socket');
    server = handle2;

    // The client's reconnect loop re-handshakes against the new server.
    await waitFor(() => client.connected === true, 4000);

    // A NEW request (fresh requestId) succeeds on the new server.
    const second = await client.request(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-after-restart',
      }),
    );
    expect(second.ok).toBe(true);

    // No double-processing: exactly the two DISTINCT tasks were handled.
    const handledTaskIds = processTaskIpcMock.mock.calls.map(
      (c) => (c[0] as { taskId?: string }).taskId,
    );
    expect(handledTaskIds).toEqual([
      'task-before-restart',
      'task-after-restart',
    ]);
  });

  // =========================================================================
  // 6. Worker reconnect with an in-flight requestId that already completed →
  //    resend the byte-identical signed payload → rejected as replay
  //    (consumed-id) and the handler ran EXACTLY once.
  // =========================================================================

  it('6. reconnect with an already-completed requestId → replay-rejected, handler ran exactly once', async () => {
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'first' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshakeFake(handle, auth);

    // The signed payload carries a stable requestId (inside the envelope) — the
    // same bytes are what a worker would resend after a reconnect.
    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-once',
    });

    client.sendReq('task', payload, 'req-1');
    const first = await client.waitForId('req-1');
    expect((first.payload as { ok?: boolean }).ok).toBe(true);

    // Simulate the reconnect: drop, re-handshake on a fresh connection, resend
    // the byte-identical payload.
    client.destroy();
    await client.waitClose();
    await waitFor(() => handle.connectionsForFolder(FOLDER).length === 0);

    const reconnected = await handshakeFake(handle, auth);
    reconnected.sendReq('task', payload, 'req-2');
    const second = await reconnected.waitForId('req-2');
    expect((second.payload as { ok?: boolean }).ok).toBe(false);
    expect((second.payload as { code?: string }).code).toBe('invalid_request');

    // The handler ran EXACTLY once — the replay never reached it.
    expect(processTaskIpcMock).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // 7. Reconnect storm → a reconnecting client against a server that goes down
  //    then up a few times converges to connected with bounded attempts,
  //    pending settled each cycle, no unbounded growth; eventually services a
  //    request.
  // =========================================================================

  it('7. reconnect storm → converges to connected with pending settled each cycle, eventually services a request', async () => {
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'survived' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    const socketPath = socketPathFor();
    const auth = makeAuth(FOLDER, THREAD_ID);

    let handle = await startIpcSocketServer(buildDeps(), { socketPath });
    if (!handle) throw new Error('server failed to start');
    server = handle;

    const rejections: string[] = [];
    const client = new IpcSocketClient({
      socketPath,
      buildHello: () =>
        buildHelloPayload(auth.authToken, {
          folder: FOLDER,
          threadId: THREAD_ID,
        }),
      reconnect: {
        enabled: true,
        baseDelayMs: 5,
        maxDelayMs: 20,
        maxAttempts: 50,
      },
      randomFn: () => 1,
    });
    realClients.push(client);
    await client.connect();
    expect(client.connected).toBe(true);

    // Bounce the server down→up a few cycles. On each down, any pending request
    // is settled (rejected connection_lost), and the client reconnects on up.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Fire a request that will be interrupted by the bounce, to prove pending
      // is settled (never hangs) on each cycle.
      const interrupted = client
        .request(
          'task',
          buildTaskPayload(auth.authToken, auth.responseKeyId, {
            taskId: `task-storm-${cycle}`,
          }),
          { timeoutMs: 10_000 },
        )
        .catch((err: IpcRequestError) => {
          rejections.push(err.code);
          return undefined;
        });

      await handle.stop();
      await waitFor(() => client.connected === false, 3000);
      // The interrupted request must have settled (not hung) by the time the
      // connection dropped.
      await interrupted;

      handle = await startIpcSocketServer(buildDeps(), { socketPath });
      if (!handle) throw new Error(`server failed to restart (cycle ${cycle})`);
      server = handle;
      await waitFor(() => client.connected === true, 4000);
    }

    // Every interrupted request was rejected promptly with connection_lost — no
    // unbounded pending growth, no silent hang.
    expect(rejections.length).toBe(3);
    for (const code of rejections) {
      expect(code).toBe('connection_lost');
    }

    // Converged: the client services a fresh request on the final server.
    const final = await client.request(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-storm-final',
      }),
    );
    expect(final.ok).toBe(true);
  });
});
