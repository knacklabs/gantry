import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';
import type { ModelCredentialRepository } from '../../../../domain/ports/repositories.js';
import type { ModelCredential, ModelCredentialFieldFingerprint, ModelCredentialMetadata, ModelCredentialProvider } from '../../../../domain/model-credentials/model-credentials.js';
import type { ModelCredentialPayload } from '../../../../shared/model-provider-registry.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresModelCredentialRepository implements ModelCredentialRepository {
    private readonly db;
    private readonly runtimeSecrets;
    constructor(db: CanonicalDb, runtimeSecrets?: RuntimeSecretProvider);
    getModelCredential(input: {
        appId: ModelCredential['appId'];
        providerId: ModelCredentialProvider;
    }): Promise<ModelCredential | null>;
    listModelCredentials(input: {
        appId: ModelCredentialMetadata['appId'];
    }): Promise<ModelCredentialMetadata[]>;
    upsertModelCredential(input: {
        appId: ModelCredentialMetadata['appId'];
        providerId: ModelCredentialProvider;
        authMode: string;
        schemaVersion: number;
        payload: ModelCredentialPayload;
        fingerprint: string;
        fieldFingerprints: ModelCredentialFieldFingerprint[];
        actor?: string;
        now?: string;
    }): Promise<ModelCredentialMetadata>;
    disableModelCredential(input: {
        appId: ModelCredentialMetadata['appId'];
        providerId: ModelCredentialProvider;
        actor?: string;
        now?: string;
    }): Promise<ModelCredentialMetadata | null>;
}
