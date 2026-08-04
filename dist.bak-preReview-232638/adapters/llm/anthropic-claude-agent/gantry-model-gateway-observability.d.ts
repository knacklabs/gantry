import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
import { type GatewayCallObservation, type GatewayCallTokenContext, type GatewayStreamTap } from '../observability/genai-spans.js';
export declare function beginGatewayObservation(input: {
    token: GatewayCallTokenContext;
    providerId: string;
    upstreamUrl: URL;
    body: Buffer;
}): {
    observation: GatewayCallObservation | undefined;
    requestBody: Buffer;
};
export declare function failGatewayObservation(observation: GatewayCallObservation | undefined, error: unknown): void;
export declare function finishGatewayNonStreaming(observation: GatewayCallObservation | undefined, status: number, response: Response, responseJson: unknown, normalizedUsage: NormalizedModelUsage | undefined): void;
export declare function resolveGatewayTap(observation: GatewayCallObservation | undefined, response: Response): GatewayStreamTap | undefined;
