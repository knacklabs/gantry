import { GetSecretValueCommand, SecretsManagerClient, } from '@aws-sdk/client-secrets-manager';
import { runtimeSecretRefTarget } from '../../domain/ports/runtime-secret-provider.js';
export class AwsSecretsManagerRuntimeSecretProvider {
    fallback;
    region;
    client;
    constructor(fallback, region = process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION) {
        this.fallback = fallback;
        this.region = region;
    }
    getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) {
            throw new Error(`${runtimeSecretRefTarget(ref).name} is required.`);
        }
        return value;
    }
    getOptionalSecret(ref) {
        const target = runtimeSecretRefTarget(ref);
        if (target.source === 'env')
            return this.fallback.getOptionalSecret(ref);
        return undefined;
    }
    async getOptionalSecretAsync(ref) {
        const target = runtimeSecretRefTarget(ref);
        if (target.source === 'env') {
            return ((await this.fallback.getOptionalSecretAsync?.(ref)) ??
                this.fallback.getOptionalSecret(ref));
        }
        if (target.source !== 'aws-sm')
            return undefined;
        const result = await this.fetchAwsSecret(target.name);
        if (result.SecretString)
            return result.SecretString;
        return result.SecretBinary
            ? Buffer.from(result.SecretBinary).toString('utf8')
            : undefined;
    }
    async fetchAwsSecret(secretId) {
        try {
            return await this.secretsManager().send(new GetSecretValueCommand({ SecretId: secretId }));
        }
        catch (err) {
            if (!isOptionalAwsSecretResolutionError(err))
                throw err;
            return {};
        }
    }
    secretsManager() {
        return (this.client ??= new SecretsManagerClient({
            ...(this.region ? { region: this.region } : {}),
        }));
    }
}
function isOptionalAwsSecretResolutionError(err) {
    if (!err || typeof err !== 'object')
        return false;
    const name = String(err.name ?? '');
    if ([
        'AccessDeniedException',
        'ConfigError',
        'CredentialsProviderError',
        'DecryptionFailure',
        'ExpiredTokenException',
        'InvalidRequestException',
        'ResourceNotFoundException',
        'UnrecognizedClientException',
    ].includes(name)) {
        return true;
    }
    const message = String(err.message ?? '');
    return (message.includes('Region is missing') ||
        message.includes('Could not load credentials'));
}
