import type { CredentialBrokerHealth } from '../../domain/models/credentials.js';
import type { RuntimeSecretProvider, RuntimeSecretRef } from '../../domain/ports/runtime-secret-provider.js';
export declare class EnvRuntimeSecretProvider implements RuntimeSecretProvider {
    private readonly source;
    constructor(source?: NodeJS.ProcessEnv);
    getSecret(ref: RuntimeSecretRef): string;
    getOptionalSecret(ref: RuntimeSecretRef): string | undefined;
    healthCheck(refs?: RuntimeSecretRef[]): Promise<CredentialBrokerHealth>;
}
