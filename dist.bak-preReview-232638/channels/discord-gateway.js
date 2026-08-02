import { logger } from '../infrastructure/logging/logger.js';
export class DiscordGatewayConnection {
    input;
    connected = false;
    socket = null;
    heartbeat = null;
    reconnectTimer = null;
    sequence = null;
    sessionId = '';
    shuttingDown = false;
    reconnectAttempts = 0;
    constructor(input) {
        this.input = input;
    }
    isConnected() {
        return this.connected;
    }
    async connect() {
        this.shuttingDown = false;
        await this.open();
    }
    disconnect() {
        this.shuttingDown = true;
        this.clearReconnect();
        this.clearHeartbeat();
        this.connected = false;
        this.socket?.close(1000, 'Gantry shutdown');
        this.socket = null;
    }
    async open() {
        const response = await fetch(`${this.input.apiRoot}/gateway/bot`, {
            headers: {
                authorization: `Bot ${this.input.botToken}`,
                accept: 'application/json',
                'content-type': 'application/json',
            },
        });
        if (!response.ok)
            throw new Error('Discord gateway discovery failed');
        const gateway = (await response.json());
        if (!gateway.url)
            throw new Error('Discord gateway URL missing');
        this.socket = this.input.createWebSocket(`${gateway.url}/?v=10&encoding=json`);
        this.connected = true;
        this.socket.onmessage = (event) => {
            void this.handle(event.data).catch((err) => {
                logger.warn({ err }, 'Discord gateway message handling failed');
            });
        };
        this.socket.onerror = (event) => {
            logger.warn({ event }, 'Discord gateway socket error');
        };
        this.socket.onclose = () => {
            this.clearHeartbeat();
            this.connected = false;
            this.socket = null;
            this.scheduleReconnect();
        };
    }
    async handle(raw) {
        const payload = JSON.parse(String(raw));
        if (typeof payload.s === 'number')
            this.sequence = payload.s;
        if (payload.op === 10) {
            const hello = payload.d;
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
        if (payload.op === 11 || payload.op !== 0)
            return;
        if (payload.t === 'READY') {
            this.sessionId =
                payload.d?.session_id ||
                    this.sessionId;
            this.reconnectAttempts = 0;
        }
        else if (payload.t === 'RESUMED') {
            this.reconnectAttempts = 0;
        }
        await this.input.onDispatch(payload);
    }
    startHeartbeat(intervalMs) {
        this.clearHeartbeat();
        this.send({ op: 1, d: this.sequence });
        this.heartbeat = setInterval(() => this.send({ op: 1, d: this.sequence }), intervalMs);
        this.heartbeat.unref?.();
    }
    clearHeartbeat() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = null;
    }
    clearReconnect() {
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }
    scheduleReconnect() {
        if (this.shuttingDown || this.reconnectTimer)
            return;
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
    reconnectNow() {
        this.clearReconnect();
        this.clearHeartbeat();
        const socket = this.socket;
        this.socket = null;
        this.connected = false;
        socket?.close(4000, 'Discord requested reconnect');
        this.scheduleReconnect();
    }
    send(payload) {
        this.socket?.send(JSON.stringify(payload));
    }
    identifyOrResume() {
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
