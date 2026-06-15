import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeFrame, FrameDecoder } from '@core/shared/ipc-frame.js';
import {
  encodeWireFrame,
  parseWireFrame,
  type IpcWireFrame,
} from '@core/shared/ipc-wire.js';
import {
  IpcConnection,
  type DuplexLike,
  type IpcConnectionOptions,
  type IpcConnectionScope,
} from '@core/shared/ipc-connection.js';

// ---------------------------------------------------------------------------
// Fake duplex
// ---------------------------------------------------------------------------

class FakeDuplex extends EventEmitter implements DuplexLike {
  outbound: Buffer[] = [];
  destroyed = false;

  write(data: Buffer): boolean {
    this.outbound.push(data);
    return true;
  }

  feed(chunk: Buffer): void {
    this.emit('data', chunk);
  }

  end(): void {
    this.emit('close');
  }

  destroy(err?: Error): void {
    if (!this.destroyed) {
      this.destroyed = true;
      // Emit 'close' like a real socket does after destroy
      setImmediate(() => this.emit('close'));
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: decode all outbound frames back into IpcWireFrame[]
// ---------------------------------------------------------------------------

function decodeOutbound(outbound: Buffer[]): IpcWireFrame[] {
  const decoder = new FrameDecoder();
  const frames: IpcWireFrame[] = [];
  for (const buf of outbound) {
    const bodies = decoder.push(buf);
    for (const body of bodies) {
      frames.push(parseWireFrame(body.toString('utf8')));
    }
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Helper: build a framed wire buffer
// ---------------------------------------------------------------------------

function makeFramed(frame: IpcWireFrame): Buffer {
  return encodeFrame(Buffer.from(encodeWireFrame(frame), 'utf8'));
}

// ---------------------------------------------------------------------------
// Shared frame fixtures
// ---------------------------------------------------------------------------

const REQ_FRAME: IpcWireFrame = {
  v: 1,
  type: 'req',
  channel: 'task',
  id: 'req-1',
  payload: { action: 'run' },
};

const PING_FRAME: IpcWireFrame = {
  v: 1,
  type: 'ctrl',
  channel: null,
  ctrl: 'ping',
  id: 'p1',
  payload: {},
};

const PONG_FRAME: IpcWireFrame = {
  v: 1,
  type: 'ctrl',
  channel: null,
  ctrl: 'pong',
  id: 'p1',
  payload: {},
};

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function makeConn(overrides: Partial<IpcConnectionOptions> = {}): {
  sock: FakeDuplex;
  onFrame: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  conn: IpcConnection;
} {
  const sock = new FakeDuplex();
  const onFrame = vi.fn();
  const onClose = vi.fn();
  const onError = vi.fn();
  const conn = new IpcConnection({
    socket: overrides.socket ?? sock,
    onFrame,
    onClose,
    onError,
    ...overrides,
  });
  return { sock, onFrame, onClose, onError, conn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IpcConnection', () => {
  // 1. Single inbound frame
  it('forwards a single inbound req frame to onFrame', () => {
    const { sock, onFrame } = makeConn();
    sock.feed(makeFramed(REQ_FRAME));

    expect(onFrame).toHaveBeenCalledOnce();
    const [received] = onFrame.mock.calls[0];
    expect(received).toEqual(REQ_FRAME);
  });

  // 2. Split inbound: frame delivered in two chunks
  it('reassembles a frame split across two chunks', () => {
    const { sock, onFrame } = makeConn();
    const full = makeFramed(REQ_FRAME);
    const mid = Math.floor(full.length / 2);

    sock.feed(full.subarray(0, mid));
    expect(onFrame).not.toHaveBeenCalled();

    sock.feed(full.subarray(mid));
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame.mock.calls[0][0]).toEqual(REQ_FRAME);
  });

  // 3. Coalesced: two frames in one chunk → two onFrame calls
  it('handles two frames coalesced in a single chunk', () => {
    const { sock, onFrame } = makeConn();
    const frame2: IpcWireFrame = {
      v: 1,
      type: 'resp',
      channel: 'task',
      id: 'resp-1',
      payload: { ok: true },
    };
    const combined = Buffer.concat([makeFramed(REQ_FRAME), makeFramed(frame2)]);
    sock.feed(combined);

    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[0][0]).toEqual(REQ_FRAME);
    expect(onFrame.mock.calls[1][0]).toEqual(frame2);
  });

  // 4. send() writes a correctly framed wire frame to outbound
  it('send() writes a single length-prefixed frame that decodes back identically', () => {
    const { sock, conn } = makeConn();
    conn.send(REQ_FRAME);

    expect(sock.outbound).toHaveLength(1);
    const decoded = decodeOutbound(sock.outbound);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(REQ_FRAME);
  });

  // 5. Auto-pong: ctrl ping → ctrl pong on outbound, not forwarded to onFrame
  it('auto-responds to a ping with a matching pong and does not forward to onFrame', () => {
    const { sock, onFrame } = makeConn();
    sock.feed(makeFramed(PING_FRAME));

    expect(onFrame).not.toHaveBeenCalled();
    const decoded = decodeOutbound(sock.outbound);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      v: 1,
      type: 'ctrl',
      ctrl: 'pong',
      id: 'p1',
      channel: null,
      payload: {},
    });
  });

  // 6. Pong received: not forwarded
  it('does not forward an inbound pong to onFrame', () => {
    const { sock, onFrame } = makeConn();
    sock.feed(makeFramed(PONG_FRAME));
    expect(onFrame).not.toHaveBeenCalled();
  });

  // 7. Malformed inbound frame → onError + destroy('protocol_error')
  it('fires onError and closes with protocol_error on a malformed frame body', () => {
    const { sock, onError, onClose, conn } = makeConn();
    // valid length-prefix wrapping invalid JSON
    const badBody = Buffer.from('{not json', 'utf8');
    sock.feed(encodeFrame(badBody));

    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toBe('protocol_error');
    expect(conn.closed).toBe(true);

    // subsequent send is a no-op
    conn.send(REQ_FRAME);
    expect(sock.outbound).toHaveLength(0);
  });

  // 8. Oversized inbound → destroy('frame_too_large')
  it('fires onClose with frame_too_large when the declared frame length exceeds maxBytes', () => {
    const { sock, onClose } = makeConn({ maxBytes: 8 });
    // Build a raw 4-byte header declaring length 100 (exceeds maxBytes=8)
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(100, 0);
    sock.feed(header);

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toBe('frame_too_large');
  });

  // 9. bindScope: set once; throws on second call; scope getter works
  it('bindScope stores the scope and throws if called twice', () => {
    const { conn } = makeConn();
    const scope: IpcConnectionScope = {
      sourceAgentFolder: 'boondi',
      role: 'runner',
    };

    expect(conn.scope).toBeUndefined();
    conn.bindScope(scope);
    expect(conn.scope).toBe(scope);

    expect(() => conn.bindScope(scope)).toThrow('scope already bound');
  });

  // 10. Heartbeat: ping sent, then heartbeat_timeout on no pong
  it('sends a heartbeat ping and destroys with heartbeat_timeout when pong is absent', () => {
    vi.useFakeTimers();
    try {
      const { sock, onClose } = makeConn({
        heartbeatIntervalMs: 20,
        maxMissedPongs: 1,
      });
      const conn = new IpcConnection({
        socket: sock,
        heartbeatIntervalMs: 20,
        maxMissedPongs: 1,
        onFrame: vi.fn(),
        onClose,
        onError: vi.fn(),
      });

      conn.startHeartbeat();

      // First tick: missedPongs becomes 1, sends ping
      vi.advanceTimersByTime(20);
      const firstOutbound = decodeOutbound([...sock.outbound]);
      expect(
        firstOutbound.some((f) => f.type === 'ctrl' && f.ctrl === 'ping'),
      ).toBe(true);
      sock.outbound.length = 0; // clear

      // Second tick: missedPongs becomes 2 > maxMissedPongs(1) → heartbeat_timeout
      vi.advanceTimersByTime(20);

      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose.mock.calls[0][0]).toBe('heartbeat_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  // 11. destroy() idempotent: onClose called exactly once
  it('is idempotent: calling destroy twice fires onClose exactly once', () => {
    const { conn, onClose } = makeConn();
    conn.destroy('test_reason');
    conn.destroy('test_reason_again');

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toBe('test_reason');
    expect(conn.closed).toBe(true);
  });

  // Extra: socket close event triggers destroy
  it('destroys with socket_closed when the underlying socket closes', () => {
    const { sock, onClose } = makeConn();
    sock.emit('close');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toBe('socket_closed');
  });

  // Extra: socket error event triggers onError + destroy
  it('fires onError and destroys with socket_error on a socket error event', () => {
    const { sock, onError, onClose } = makeConn();
    const err = new Error('ECONNRESET');
    sock.emit('error', err);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBe(err);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toBe('socket_error');
  });
});
