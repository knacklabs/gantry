import type { AppId } from '../../domain/app/app.js';
import type { RuntimeSecretProvider, RuntimeSecretRef } from '../../domain/ports/runtime-secret-provider.js';
import type { CapabilitySecretRepository } from '../../domain/ports/repositories.js';
export declare class RepositoryRuntimeSecretProvider implements RuntimeSecretProvider {
    private readonly input;
    constructor(input: {
        appId: AppId;
        repository: CapabilitySecretRepository;
        fallback: RuntimeSecretProvider;
    });
    getSecret(ref: RuntimeSecretRef): string;
    getOptionalSecret(ref: RuntimeSecretRef): string | undefined;
    getOptionalSecretAsync(ref: RuntimeSecretRef): Promise<string | undefined>;
}
export declare function createRepositoryRuntimeSecretProvider(input: {
    appId: AppId;
    repository: CapabilitySecretRepository;
}): RuntimeSecretProvider;
