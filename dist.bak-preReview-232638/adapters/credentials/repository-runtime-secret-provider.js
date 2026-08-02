import { runtimeSecretRefTarget } from '../../domain/ports/runtime-secret-provider.js';
import { AwsSecretsManagerRuntimeSecretProvider } from './aws-secrets-manager-runtime-secret-provider.js';
import { EnvRuntimeSecretProvider } from './env-runtime-secret-provider.js';
export class RepositoryRuntimeSecretProvider {
    input;
    constructor(input) {
        this.input = input;
    }
    getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value)
            throw new Error(`${runtimeSecretRefTarget(ref).name} is required.`);
        return value;
    }
    getOptionalSecret(ref) {
        const target = runtimeSecretRefTarget(ref);
        return target.source !== 'gantry-secret'
            ? this.input.fallback.getOptionalSecret(ref)
            : undefined;
    }
    async getOptionalSecretAsync(ref) {
        const target = runtimeSecretRefTarget(ref);
        if (target.source !== 'gantry-secret') {
            return ((await this.input.fallback.getOptionalSecretAsync?.(ref)) ??
                this.input.fallback.getOptionalSecret(ref));
        }
        const secret = await this.input.repository.getSecret({
            appId: this.input.appId,
            name: target.name,
        });
        return secret?.value || undefined;
    }
}
export function createRepositoryRuntimeSecretProvider(input) {
    return new RepositoryRuntimeSecretProvider({
        ...input,
        fallback: new AwsSecretsManagerRuntimeSecretProvider(new EnvRuntimeSecretProvider()),
    });
}
