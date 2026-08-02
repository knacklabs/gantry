import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { EgressGatewayUpstreamProxy } from './egress-gateway.js';
export interface EgressTunnelTarget {
    host: string;
    port: number;
    authority: string;
    connectHost?: string;
}
export declare function requestDirect(req: http.IncomingMessage, target: URL, connectHost?: string): http.ClientRequest;
export declare function requestViaUpstreamProxy(upstream: EgressGatewayUpstreamProxy, req: http.IncomingMessage, target: URL, connectHost?: string): http.ClientRequest;
export declare function tunnelDirect(input: {
    target: EgressTunnelTarget;
    clientSocket: Duplex;
    head: Buffer;
    trackSocket: (socket: Duplex) => void;
}): Promise<void>;
export declare function tunnelViaUpstreamProxy(input: {
    upstream: EgressGatewayUpstreamProxy;
    target: EgressTunnelTarget;
    clientSocket: Duplex;
    head: Buffer;
    trackSocket: (socket: Duplex) => void;
}): Promise<void>;
