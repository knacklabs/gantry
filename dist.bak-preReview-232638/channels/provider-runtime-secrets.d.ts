import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
interface ProviderRuntimeSecretSettings {
    providerAccounts?: Record<string, {
        provider: string;
        runtimeSecretRefs: Record<string, string | undefined>;
    } | undefined>;
}
export declare function getProviderRuntimeSecret(input: {
    providerId: string;
    providerAccountId?: string;
    key: string;
    defaultEnvName?: string;
    settings?: ProviderRuntimeSecretSettings;
    secrets?: RuntimeSecretProvider;
}): Promise<string>;
export {};
