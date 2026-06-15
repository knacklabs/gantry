import { randomUUID } from 'crypto';
import { encodeFrame, FrameDecoder, FrameTooLargeError } from './ipc-frame.js';
import {
  encodeWireFrame,
  parseWireFrame,
  type IpcWireFrame,
} from './ipc-wire.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structural duplex interface — satisfied by `net.Socket` in production and
 * trivially by a test fake built on EventEmitter.
 */
export interface DuplexLike {
  write(data: Buffer): boolean;
  on(event: 'data', cb: (chunk: Buffer) => void): this;
  on(event: 'close', cb: () => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  end(): void;
  destroy(err?: Error): void;
}

/** Opaque scope bound once by the layer above after the hello/welcome handshake. */
export interface IpcConnectionScope {
  sourceAgentFolder: string;
  role: 'runner' | 'mcp';
  threadId?: string | null;
  appId?: string | null;
  agentId?: string | null;
  runHandle?: string | null;
  chatJid?: string | null;
}

export interface IpcConnectionOptions {
  socket: DuplexLike;
  /** Frame body size cap passed to FrameDecoder / encodeFrame. */
  maxBytes?: number;
  /** Milliseconds between heartbeat pings. Default: DEFAULT_HEARTBEAT_INTERVAL_MS (10 000). */
  heartbeatIntervalMs?: number;
  /** How many consecutive missed pongs before we close. Default: 2. */
  maxMissedPongs?: number;
  /** Called for every non-ping/pong frame received on this connection. */
  onFrame: (frame: IpcWireFrame, conn: IpcConnection) => void;
  /** Called exactly once when the connection closes, with the reason string. */
  onClose: (reason: string, conn: IpcConnection) => void;
  /** Called for parse/protocol errors and socket-level errors. */
  onError?: (err: Error, conn: IpcConnection) => void;
}

// ---------------------------------------------------------------------------
// IpcConnection
// ---------------------------------------------------------------------------

export class IpcConnection {
  private readonly socket: DuplexLike;
  private readonly decoder: FrameDecoder;
  private readonly maxBytes: number | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly maxMissedPongs: number;
  private readonly _onFrame: (frame: IpcWireFrame, conn: IpcConnection) => void;
  private readonly _onClose: (reason: string, conn: IpcConnection) => void;
  private readonly _onError?: (err: Error, conn: IpcConnection) => void;

  private _closed = false;
  private _scope: IpcConnectionScope | undefined;
  private _heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private _missedPongs = 0;

  constructor(opts: IpcConnectionOptions) {
    this.socket = opts.socket;
    this.maxBytes = opts.maxBytes;
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxMissedPongs = opts.maxMissedPongs ?? 2;
    this._onFrame = opts.onFrame;
    this._onClose = opts.onClose;
    this._onError = opts.onError;

    this.decoder = new FrameDecoder(
      opts.maxBytes != null ? { maxBytes: opts.maxBytes } : {},
    );

    this.socket.on('data', (chunk: Buffer) => this._onData(chunk));
    this.socket.on('close', () => this.destroy('socket_closed'));
    this.socket.on('error', (err: Error) => {
      this._onError?.(err, this);
      this.destroy('socket_error');
    });
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get closed(): boolean {
    return this._closed;
  }

  get scope(): IpcConnectionScope | undefined {
    return this._scope;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  bindScope(scope: IpcConnectionScope): void {
    if (this._scope !== undefined) {
      throw new Error('scope already bound');
    }
    this._scope = scope;
  }

  send(frame: IpcWireFrame): void {
    if (this._closed) return;
    try {
      const encoded = Buffer.from(encodeWireFrame(frame), 'utf8');
      const framed = encodeFrame(encoded, this.maxBytes ?? undefined);
      this.socket.write(framed);
    } catch (err) {
      if (err instanceof FrameTooLargeError) {
        this._onError?.(err, this);
        this.destroy('outbound_frame_too_large');
      } else {
        throw err;
      }
    }
  }

  startHeartbeat(): void {
    if (this._closed) return;
    const timer = setInterval(() => {
      if (this._closed) {
        clearInterval(timer);
        return;
      }
      // Increment first: if we never got a pong since the last tick we've
      // missed one more heartbeat round.
      this._missedPongs += 1;
      if (this._missedPongs > this.maxMissedPongs) {
        this.destroy('heartbeat_timeout');
        return;
      }
      this.send({
        v: 1,
        type: 'ctrl',
        channel: null,
        ctrl: 'ping',
        id: `hb-${this._missedPongs}`,
        payload: {},
      });
    }, this.heartbeatIntervalMs);

    // Don't hold the event loop open for heartbeats alone.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }

    this._heartbeatTimer = timer;
  }

  destroy(reason: string): void {
    if (this._closed) return;
    this._closed = true;

    if (this._heartbeatTimer !== undefined) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = undefined;
    }

    try {
      this.socket.destroy();
    } catch {
      // swallow
    }

    this._onClose(reason, this);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _onData(chunk: Buffer): void {
    let bodies: Buffer[];
    try {
      bodies = this.decoder.push(chunk);
    } catch (err) {
      if (err instanceof FrameTooLargeError) {
        this._onError?.(err as Error, this);
        this.destroy('frame_too_large');
      } else {
        this._onError?.(err as Error, this);
        this.destroy('protocol_error');
      }
      return;
    }

    for (const body of bodies) {
      if (this._closed) return;

      let frame: IpcWireFrame;
      try {
        frame = parseWireFrame(body.toString('utf8'));
      } catch (err) {
        this._onError?.(err as Error, this);
        this.destroy('protocol_error');
        return;
      }

      // Handle heartbeat control frames internally; never forward them.
      if (frame.type === 'ctrl') {
        if (frame.ctrl === 'ping') {
          this.send({
            v: 1,
            type: 'ctrl',
            channel: null,
            ctrl: 'pong',
            id: frame.id,
            payload: {},
          });
          continue;
        }
        if (frame.ctrl === 'pong') {
          this._missedPongs = 0;
          continue;
        }
      }

      this._onFrame(frame, this);
    }
  }
}
