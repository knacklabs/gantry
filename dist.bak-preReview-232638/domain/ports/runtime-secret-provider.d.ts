import type { CredentialBrokerHealth } from '../models/credentials.js';
export interface RuntimeSecretRef {
    env?: string;
    ref?: string;
}
export type RuntimeSecretSource = 'env' | 'gantry-secret' | 'aws-sm';
export interface ParsedRuntimeSecretRef {
    source: RuntimeSecretSource;
    name: string;
}
export interface RuntimeSecretProvider {
    getSecret(ref: RuntimeSecretRef): string;
    getOptionalSecret(ref: RuntimeSecretRef): string | undefined;
    getOptionalSecretAsync?(ref: RuntimeSecretRef): Promise<string | undefined>;
    healthCheck?(refs?: RuntimeSecretRef[]): Promise<CredentialBrokerHealth>;
}
export declare function envRuntimeSecretRef(name: string): string;
export declare function gantryRuntimeSecretRef(name: string): string;
export declare function awsSecretsManagerRuntimeSecretRef(name: string): string;
export declare function parseRuntimeSecretRefString(value: string, path?: string): ParsedRuntimeSecretRef;
export declare function normalizeRuntimeSecretRefString(value: string, path?: string): string;
export declare function runtimeSecretRefTarget(ref: RuntimeSecretRef): ParsedRuntimeSecretRef;
export declare function isForbiddenRuntimeSecretEnvName(key: string): boolean;
export declare function getOptionalRuntimeSecret(provider: RuntimeSecretProvider | undefined, ref: RuntimeSecretRef): Promise<string | undefined>;
