import type { DoctorCheck } from './doctor.js';
type ModelCredentialReadinessSettings = {
    credentialBroker: {
        mode: string;
    };
    agent: {
        defaultModel: string;
        oneTimeJobDefaultModel: string;
        recurringJobDefaultModel: string;
    };
    memory: {
        enabled: boolean;
        embeddings: {
            enabled: boolean;
            provider: string;
        };
        dreaming: {
            embeddings: {
                enabled: boolean;
                provider: string;
            };
        };
        llm: {
            models: {
                extractor: string;
                dreaming: string;
                consolidation: string;
            };
        };
    };
};
export declare function inspectModelCredentialReadiness(runtimeHome: string, settings: ModelCredentialReadinessSettings, options?: {
    live?: boolean;
    skipLiveProviderIds?: readonly string[];
}): Promise<DoctorCheck>;
export {};
