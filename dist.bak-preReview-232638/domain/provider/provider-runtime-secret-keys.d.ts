export declare function runtimeSecretKeyForEnv(providerId: string, envKey: string): string;
export declare function expectedRuntimeSecretEnvForKey(providerId: string, key: string): string | undefined;
export declare function isProviderRuntimeSecretRefTarget(providerId: string, key: string, ref: string): boolean;
