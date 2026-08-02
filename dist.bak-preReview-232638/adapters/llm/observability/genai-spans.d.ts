import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
export interface GatewayCallTokenContext {
    appId?: unknown;
    agentId?: unknown;
    runId?: unknown;
    jobId?: unknown;
    conversationId?: unknown;
    threadId?: unknown;
    apiKeyId?: string;
}
export interface GatewayStreamTap {
    transform: (chunk: Buffer) => Buffer;
    flush: () => Buffer;
}
export interface GatewayCallObservation {
    requestBody: Buffer;
    isStreaming: boolean;
    streamTapFor: (contentType: string | null | undefined, status?: number) => GatewayStreamTap | undefined;
    finish: (input: {
        status: number;
        responseJson?: unknown;
        normalizedUsage?: NormalizedModelUsage;
        errorMessage?: string;
    }) => void;
}
export declare function observeGatewayCall(input: {
    token: GatewayCallTokenContext;
    providerId: string;
    upstreamUrl: URL;
    requestBody: Buffer;
}): GatewayCallObservation | undefined;
