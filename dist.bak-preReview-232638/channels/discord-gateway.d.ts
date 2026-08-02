import type { DiscordGatewayPayload, WebSocketFactory } from './discord-types.js';
export declare class DiscordGatewayConnection {
    private readonly input;
    private connected;
    private socket;
    private heartbeat;
    private reconnectTimer;
    private sequence;
    private sessionId;
    private shuttingDown;
    private reconnectAttempts;
    constructor(input: {
        botToken: string;
        apiRoot: string;
        intents: number;
        createWebSocket: WebSocketFactory;
        onDispatch: (payload: DiscordGatewayPayload) => Promise<void>;
    });
    isConnected(): boolean;
    connect(): Promise<void>;
    disconnect(): void;
    private open;
    private handle;
    private startHeartbeat;
    private clearHeartbeat;
    private clearReconnect;
    private scheduleReconnect;
    private reconnectNow;
    private send;
    private identifyOrResume;
}
