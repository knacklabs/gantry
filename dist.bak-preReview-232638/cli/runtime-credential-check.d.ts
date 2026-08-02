export declare function resolveRuntimeEnvValue(env: Record<string, string>, key: string): string;
interface RuntimeCredentialSettings {
    providerAccounts: Record<string, {
        provider: string;
        status?: 'active' | 'disabled';
        runtimeSecretRefs: Record<string, string | undefined>;
    } | undefined>;
}
export declare function hasRuntimeCredentialConfigured(input: {
    settings?: RuntimeCredentialSettings;
    env: Record<string, string>;
    providerId: string;
    envKey: string;
    unresolvedRuntimeSecretProviderIds?: Set<string>;
}): boolean;
export {};
