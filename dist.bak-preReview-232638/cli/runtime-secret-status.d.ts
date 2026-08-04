interface RuntimeSecretStatusSettings {
    providers: Record<string, {
        enabled: boolean;
    } | undefined>;
    providerAccounts: Record<string, {
        provider: string;
        runtimeSecretRefs: Record<string, string | undefined>;
    } | undefined>;
    storage: {
        postgres: {
            urlEnv: string;
            schema: string;
        };
    };
}
export declare function collectUnresolvedRuntimeSecretProviderIds(runtimeHome: string, settings: RuntimeSecretStatusSettings): Promise<Set<string>>;
export declare function unresolvedProviderIdsFromRuntimeSecretDetails(details: string[]): Set<string>;
export declare function isMissingRuntimeCredential(input: {
    providerId: string;
    envKey: string;
    rawRef?: string;
    env: Record<string, string>;
    unresolvedRuntimeSecretProviderIds: Set<string>;
}): boolean;
export {};
