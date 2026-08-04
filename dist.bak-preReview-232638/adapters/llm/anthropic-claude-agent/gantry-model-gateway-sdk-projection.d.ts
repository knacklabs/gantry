import { type ModelProviderDefinition } from '../../../shared/model-provider-registry.js';
export declare function projectGatewayTokenEnv(input: {
    provider: ModelProviderDefinition;
    baseUrl: string;
    token: string;
}): Record<string, string>;
export declare function projectedModelCredentialEnvKeys(): string[];
