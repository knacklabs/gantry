import http from 'node:http';
import type { ModelGatewayResolvedUpstream, ModelProviderDefinition } from '../../../shared/model-provider-registry.js';
import { normalizeModelUsage } from '../../../shared/model-usage.js';
export interface GatewayResponsePayload {
    payload: Record<string, unknown>;
    requestModel?: string;
}
export declare function readGatewayResponsePayload(response: Response, requestBody: Buffer): Promise<GatewayResponsePayload | undefined>;
export declare function usageFromGatewayPayload(parsed: GatewayResponsePayload | undefined): ReturnType<typeof normalizeModelUsage>;
export declare const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
export declare class GatewayRequestBodyTooLargeError extends Error {
}
export declare class GatewayBadRequestError extends Error {
}
export declare function normalizeGatewayBindHost(host: string): string;
export declare function hostForUrl(host: string): string;
export declare function buildConfinedUpstreamUrl(provider: ModelProviderDefinition, pathParts: string[], search: string, upstream?: ModelGatewayResolvedUpstream): URL;
export declare function assertRawGatewayPathIsConfined(rawUrl: string): void;
export declare function shouldForwardGatewayResponseHeader(key: string): boolean;
export declare function pipeUpstreamBody(response: Response, res: http.ServerResponse, tap?: {
    transform(chunk: Buffer): Buffer;
    flush(): Buffer;
}): Promise<void>;
export declare function readBearerToken(req: http.IncomingMessage): string;
export declare function constantTimeEquals(left: string, right: string): boolean;
export declare function readRequestBody(req: http.IncomingMessage, limitBytes: number): Promise<Buffer>;
export declare function sanitizeProxyHeaders(headers: http.IncomingHttpHeaders): Record<string, string>;
export declare function sendGatewayJson(res: http.ServerResponse, statusCode: number, body: Record<string, unknown>): void;
