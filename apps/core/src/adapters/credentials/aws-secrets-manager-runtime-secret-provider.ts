import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';

import type {
  RuntimeSecretProvider,
  RuntimeSecretRef,
} from '../../domain/ports/runtime-secret-provider.js';
import { runtimeSecretRefTarget } from '../../domain/ports/runtime-secret-provider.js';

export class AwsSecretsManagerRuntimeSecretProvider implements RuntimeSecretProvider {
  private client: SecretsManagerClient | undefined;

  constructor(
    private readonly fallback: RuntimeSecretProvider,
    private readonly region = process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION,
  ) {}

  getSecret(ref: RuntimeSecretRef): string {
    const value = this.getOptionalSecret(ref);
    if (!value) {
      throw new Error(`${runtimeSecretRefTarget(ref).name} is required.`);
    }
    return value;
  }

  getOptionalSecret(ref: RuntimeSecretRef): string | undefined {
    const target = runtimeSecretRefTarget(ref);
    if (target.source === 'env') return this.fallback.getOptionalSecret(ref);
    return undefined;
  }

  async getOptionalSecretAsync(
    ref: RuntimeSecretRef,
  ): Promise<string | undefined> {
    const target = runtimeSecretRefTarget(ref);
    if (target.source === 'env') {
      return (
        (await this.fallback.getOptionalSecretAsync?.(ref)) ??
        this.fallback.getOptionalSecret(ref)
      );
    }
    if (target.source !== 'aws-sm') return undefined;
    const result = await this.fetchAwsSecret(target.name);
    if (result.SecretString) return result.SecretString;
    return result.SecretBinary
      ? Buffer.from(result.SecretBinary).toString('utf8')
      : undefined;
  }

  private async fetchAwsSecret(
    secretId: string,
  ): Promise<Partial<GetSecretValueCommandOutput>> {
    try {
      return await this.secretsManager().send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
    } catch (err) {
      if (!isOptionalAwsSecretResolutionError(err)) throw err;
      return {};
    }
  }

  private secretsManager(): SecretsManagerClient {
    return (this.client ??= new SecretsManagerClient({
      ...(this.region ? { region: this.region } : {}),
    }));
  }
}

function isOptionalAwsSecretResolutionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = String((err as { name?: unknown }).name ?? '');
  if (
    [
      'AccessDeniedException',
      'ConfigError',
      'CredentialsProviderError',
      'DecryptionFailure',
      'ExpiredTokenException',
      'InvalidRequestException',
      'ResourceNotFoundException',
      'UnrecognizedClientException',
    ].includes(name)
  ) {
    return true;
  }
  const message = String((err as { message?: unknown }).message ?? '');
  return (
    message.includes('Region is missing') ||
    message.includes('Could not load credentials')
  );
}
