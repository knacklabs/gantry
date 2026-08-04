export interface RuntimeStorageReadiness {
    status: 'pass' | 'warn' | 'fail';
    message: string;
    details?: string[];
    nextAction?: string;
}
interface RuntimeSecretReadinessSettings {
    storage: {
        postgres: {
            urlEnv: string;
            schema: string;
        };
    };
    providers: Record<string, {
        enabled: boolean;
    } | undefined>;
    providerAccounts: Record<string, {
        provider: string;
        status?: string;
        runtimeSecretRefs: Record<string, string | undefined>;
    } | undefined>;
}
export declare function inspectRuntimeStorageReadiness(runtimeHome: string): Promise<RuntimeStorageReadiness>;
export declare function inspectRuntimeSecretReadiness(runtimeHome: string, settings: RuntimeSecretReadinessSettings): Promise<RuntimeStorageReadiness>;
export {};
