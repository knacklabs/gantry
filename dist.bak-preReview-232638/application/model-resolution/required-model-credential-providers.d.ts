export type RequiredModelCredentialProvidersSettings = {
    agent: {
        defaultModel: string;
        oneTimeJobDefaultModel: string;
        recurringJobDefaultModel: string;
    };
    agents?: Record<string, {
        model?: string;
        oneTimeJobDefaultModel?: string;
        recurringJobDefaultModel?: string;
    } | undefined>;
    bindings?: Record<string, {
        model?: string;
    } | undefined>;
    modelFamilies?: Record<string, readonly string[]>;
    memory: {
        enabled: boolean;
        embeddings?: {
            enabled: boolean;
            provider: string;
        };
        dreaming?: {
            enabled?: boolean;
            embeddings?: {
                enabled: boolean;
                provider: string;
            };
        };
        llm?: {
            models: {
                extractor: string;
                dreaming: string;
                consolidation: string;
            };
        };
    };
};
/**
 * Compute the set of model provider IDs that the configured chat/job/memory
 * model defaults require active credentials for. Pure function shared by the
 * CLI doctor readiness check and the control-plane read-model builders.
 */
export declare function requiredModelCredentialProviders(settings: RequiredModelCredentialProvidersSettings, options?: {
    configuredProviderIds?: ReadonlySet<string>;
}): string[];
