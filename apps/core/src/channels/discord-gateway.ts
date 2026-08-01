import { logger } from '../infrastructure/logging/logger.js';
import type {
  DiscordGatewayPayload,
  WebSocketFactory,
  WebSocketLike,
} from './discord-types.js';
import type { ChannelOpts } from './channel-provider.js';
import { historyCoverageInboundCallbacks } from './conversation-history-coverage-lifecycle.js';

export async function connectDiscordGateway(input: {
  botToken: string;
  apiRoot: string;
  intents: number;
  createWebSocket: WebSocketFactory;
  channelOpts: ChannelOpts;
  options: { inbound?: boolean; interactionCallbacks?: boolean };
  onDispatch: (payload: DiscordGatewayPayload) => Promise<void>;
}): Promise<DiscordGatewayConnection | null> {
  const inboundEnabled = input.options.inbound !== false;
  const interactionCallbacksEnabled =
    input.options.interactionCallbacks ?? inboundEnabled;
  if (!inboundEnabled && !interactionCallbacksEnabled) return null;
  const gateway = new DiscordGatewayConnection({
    botToken: input.botToken,
    apiRoot: input.apiRoot,
    intents: input.intents,
    createWebSocket: input.createWebSocket,
    inboundEnabled,
    interactionCallbacksEnabled,
    onReconnect: () =>
      input.channelOpts.distrustHistoryCoverage?.(
        input.channelOpts.inboundProviderAccountIds ??
          (input.channelOpts.providerAccountId
            ? [input.channelOpts.providerAccountId]
            : []),
      ),
    ...historyCoverageInboundCallbacks(input.channelOpts),
    onDispatch: input.onDispatch,
  });
  await gateway.connect();
  return gateway;
}

export class DiscordGatewayConnection {
  private connected = false;
  private socket: WebSocketLike | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence: number | null = null;
  private sessionId = '';
  private shuttingDown = false;
  private reconnectAttempts = 0;
  private reconnectDistrusted = false;
  private reconnectNeedsRefence = false;

  constructor(
    private readonly input: {
      botToken: string;
      apiRoot: string;
      intents: number;
      createWebSocket: WebSocketFactory;
      inboundEnabled: boolean;
      interactionCallbacksEnabled: boolean;
      onReconnect?: () => void;
      onInboundStateChange?: (active: boolean) => void;
      onDispatchFailure?: () => void;
      onDispatch: (payload: DiscordGatewayPayload) => Promise<void>;
    },
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    await this.open();
  }

  disconnect(): void {
    this.shuttingDown = true;
    this.clearReconnect();
    this.clearHeartbeat();
    this.connected = false;
    this.setInboundActive(false);
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close(1000, 'Gantry shutdown');
  }

  private async open(): Promise<void> {
    const response = await fetch(`${this.input.apiRoot}/gateway/bot`, {
      headers: {
        authorization: `Bot ${this.input.botToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    if (!response.ok) throw new Error('Discord gateway discovery failed');
    const gateway = (await response.json()) as { url?: string };
    if (!gateway.url) throw new Error('Discord gateway URL missing');
    this.socket = this.input.createWebSocket(
      `${gateway.url}/?v=10&encoding=json`,
    );
    this.reconnectDistrusted = false;
    this.connected = true;
    this.socket.onmessage = (event) => {
      void this.handle(event.data).catch((err) => {
        if (this.input.inboundEnabled) this.input.onDispatchFailure?.();
        logger.warn({ err }, 'Discord gateway message handling failed');
      });
    };
    this.socket.onerror = (event) => {
      logger.warn({ event }, 'Discord gateway socket error');
    };
    this.socket.onclose = () => {
      this.clearHeartbeat();
      this.connected = false;
      this.setInboundActive(false);
      this.socket = null;
      if (!this.shuttingDown) this.distrustReconnectTransition();
      this.scheduleReconnect();
    };
  }

  private async handle(raw: unknown): Promise<void> {
    const payload = JSON.parse(String(raw)) as DiscordGatewayPayload;
    if (typeof payload.s === 'number') this.sequence = payload.s;
    if (payload.op === 10) {
      const hello = payload.d as { heartbeat_interval?: number };
      this.startHeartbeat(hello.heartbeat_interval ?? 45_000);
      this.identifyOrResume();
      return;
    }
    if (payload.op === 1) {
      this.send({ op: 1, d: this.sequence });
      return;
    }
    if (payload.op === 7) {
      this.reconnectNow();
      return;
    }
    if (payload.op === 9) {
      if (payload.d !== true) {
        this.sessionId = '';
        this.sequence = null;
      }
      this.reconnectNow();
      return;
    }
    if (payload.op === 11 || payload.op !== 0) return;
    if (payload.t === 'READY') {
      this.sessionId =
        (payload.d as { session_id?: string } | undefined)?.session_id ||
        this.sessionId;
      this.reconnectAttempts = 0;
    } else if (payload.t === 'RESUMED') {
      this.reconnectAttempts = 0;
    }
    if (
      !this.shuttingDown &&
      (payload.t === 'READY' || payload.t === 'RESUMED')
    ) {
      this.setInboundActive(true);
    }
    if (
      !this.shuttingDown &&
      (payload.t === 'READY' || payload.t === 'RESUMED') &&
      this.reconnectNeedsRefence
    ) {
      this.reconnectNeedsRefence = false;
      this.input.onReconnect?.();
    }
    if (
      !this.input.inboundEnabled &&
      (payload.t === 'MESSAGE_CREATE' ||
        payload.t === 'MESSAGE_DELETE' ||
        payload.t === 'MESSAGE_DELETE_BULK')
    ) {
      return;
    }
    if (
      !this.input.interactionCallbacksEnabled &&
      payload.t === 'INTERACTION_CREATE'
    ) {
      return;
    }
    await this.input.onDispatch(payload);
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.send({ op: 1, d: this.sequence });
    this.heartbeat = setInterval(
      () => this.send({ op: 1, d: this.sequence }),
      intervalMs,
    );
    this.heartbeat.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open().catch((err) => {
        logger.warn({ err }, 'Discord gateway reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private reconnectNow(): void {
    this.clearReconnect();
    this.clearHeartbeat();
    this.distrustReconnectTransition();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.setInboundActive(false);
    socket?.close(4000, 'Discord requested reconnect');
    this.scheduleReconnect();
  }

  private distrustReconnectTransition(): void {
    if (!this.input.inboundEnabled) return;
    if (this.reconnectDistrusted) return;
    this.reconnectDistrusted = true;
    this.reconnectNeedsRefence = true;
    this.input.onReconnect?.();
  }

  private setInboundActive(active: boolean): void {
    if (this.input.inboundEnabled) this.input.onInboundStateChange?.(active);
  }

  private send(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private identifyOrResume(): void {
    if (this.sessionId && this.sequence !== null) {
      this.send({
        op: 6,
        d: {
          token: this.input.botToken,
          session_id: this.sessionId,
          seq: this.sequence,
        },
      });
      return;
    }
    this.send({
      op: 2,
      d: {
        token: this.input.botToken,
        intents: this.input.intents,
        properties: {
          os: process.platform,
          browser: 'gantry',
          device: 'gantry',
        },
      },
    });
  }
}
