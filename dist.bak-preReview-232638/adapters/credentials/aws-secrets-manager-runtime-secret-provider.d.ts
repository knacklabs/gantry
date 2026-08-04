import type { RuntimeSecretProvider, RuntimeSecretRef } from '../../domain/ports/runtime-secret-provider.js';
export declare class AwsSecretsManagerRuntimeSecretProvider implements RuntimeSecretProvider {
    private readonly fallback;
    private readonly region;
    private client;
    constructor(fallback: RuntimeSecretProvider, region?: string | undefined);
    getSecret(ref: RuntimeSecretRef): string;
    getOptionalSecret(ref: RuntimeSecretRef): string | undefined;
    getOptionalSecretAsync(ref: RuntimeSecretRef): Promise<string | undefined>;
    private fetchAwsSecret;
    private secretsManager;
}
