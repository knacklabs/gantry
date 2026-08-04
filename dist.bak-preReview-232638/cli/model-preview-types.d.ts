export interface ModelPreviewResponse {
    target?: string;
    jobId?: string;
    agentId?: string;
    scope?: string;
    agentHarness?: string;
    executionProviderId?: string;
    credentialProfile?: string;
    incompatible?: string;
    selection?: {
        effectiveAlias?: string | null;
        source?: string;
        inherited?: boolean;
        model?: {
            displayName?: string;
            responseFamily?: string;
            modelRoute?: {
                label?: string;
                metadata?: {
                    providerModelId?: string;
                };
            };
            cacheSupport?: {
                statusLabel?: string;
            };
        } | null;
    };
    why?: string[];
}
