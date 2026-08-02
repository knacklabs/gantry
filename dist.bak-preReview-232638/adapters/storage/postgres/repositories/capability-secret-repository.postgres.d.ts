import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';
import type { CapabilitySecretRepository } from '../../../../domain/ports/repositories.js';
import type { CapabilitySecret, CapabilitySecretMetadata } from '../../../../domain/capability-secrets/capability-secrets.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresCapabilitySecretRepository implements CapabilitySecretRepository {
    private readonly db;
    private readonly runtimeSecrets;
    constructor(db: CanonicalDb, runtimeSecrets?: RuntimeSecretProvider);
    getSecret(input: {
        appId: CapabilitySecret['appId'];
        name: string;
    }): Promise<CapabilitySecret | null>;
    listSecrets(input: {
        appId: CapabilitySecretMetadata['appId'];
    }): Promise<CapabilitySecretMetadata[]>;
    upsertSecret(input: {
        appId: CapabilitySecretMetadata['appId'];
        name: string;
        value: string;
        allowedCapabilityIds?: string[];
        actor?: string;
        now?: string;
    }): Promise<CapabilitySecretMetadata>;
    deleteSecret(input: {
        appId: CapabilitySecretMetadata['appId'];
        name: string;
    }): Promise<boolean>;
}
export declare function encryptCapabilitySecretValue(value: string, context: {
    appId: string;
    name: string;
}, runtimeSecrets: RuntimeSecretProvider): string;
export declare function decryptCapabilitySecretValue(stored: string, context: {
    appId: string;
    name: string;
}, runtimeSecrets: RuntimeSecretProvider): string;
