import { type ModelCredentialPayload, type ModelGatewayResolvedUpstream, type ModelProviderDefinition } from '../../../shared/model-provider-registry.js';
export declare function resolveGatewayUpstream(provider: ModelProviderDefinition, authMode: string, payload: ModelCredentialPayload): ModelGatewayResolvedUpstream;
export declare function assertProviderPathAllowed(provider: ModelProviderDefinition, upstreamPathname: string, method?: string, upstreamPathPrefix?: string): void;
export declare function isGatewayMethodAllowed(method: string, gatewayPathname: string): boolean;
export declare function isProviderBatchPath(provider: ModelProviderDefinition, providerPath: string): boolean;
export declare function isProviderBatchSubmissionPath(provider: ModelProviderDefinition, providerPath: string, method: string): boolean;
export declare function isProviderBatchResultPath(provider: ModelProviderDefinition, providerPath: string): boolean;
export declare function openAiBatchIdFromPath(providerPath: string): string | undefined;
export declare function openAiFileContentIdFromPath(providerPath: string): string | undefined;
export declare function injectProviderAuth(input: {
    headers: Record<string, string>;
    provider: ModelProviderDefinition;
    authMode: string;
    payload: ModelCredentialPayload;
    method: string;
    upstreamUrl: URL;
    body: Buffer;
}): Promise<void>;
