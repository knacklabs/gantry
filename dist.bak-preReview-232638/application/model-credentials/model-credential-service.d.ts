import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import type { ModelCredential, ModelCredentialFieldFingerprint, ModelCredentialProvider, ModelCredentialStatus } from '../../domain/model-credentials/model-credentials.js';
import { type ModelCredentialPayload } from '../../shared/model-provider-registry.js';
type ModelCredentialAuditPublisher = (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
export type ModelCredentialHealth = 'ready' | 'missing' | 'disabled';
export declare class ModelCredentialService {
    private readonly credentials;
    private readonly audit?;
    constructor(credentials: ModelCredentialRepository, audit?: ModelCredentialAuditPublisher | undefined);
    list(input: {
        appId: AppId;
    }): Promise<{
        providerId: string;
        label: string;
        role: string;
        configured: boolean;
        authMode: string | null;
        status: ModelCredentialStatus;
        health: ModelCredentialHealth;
        fingerprint: string | null;
        fieldFingerprints: ModelCredentialFieldFingerprint[];
        schemaVersion: number;
        configuredFields: string[];
        credentialModes: {
            id: string;
            label: string;
            helpText: string;
            schemaVersion: number;
            gatewayAuthStrategy: import("../../shared/model-provider-registry.js").ModelGatewayAuthStrategy;
            fields: {
                name: string;
                label: string;
                secret: boolean;
                required: boolean;
            }[];
        }[];
        supportedWorkloads: readonly import("../../shared/model-catalog.js").ModelWorkload[];
        updatedAt: string | null;
    }[]>;
    set(input: {
        appId: AppId;
        providerId: string;
        authMode?: string;
        payload: unknown;
        actor?: string;
    }): Promise<import("../../domain/model-credentials/model-credentials.js").ModelCredentialMetadata>;
    rotate(input: {
        appId: AppId;
        providerId: string;
        payload: unknown;
        actor?: string;
    }): Promise<import("../../domain/model-credentials/model-credentials.js").ModelCredentialMetadata>;
    disable(input: {
        appId: AppId;
        providerId: string;
        actor?: string;
    }): Promise<import("../../domain/model-credentials/model-credentials.js").ModelCredentialMetadata | null>;
    getActiveCredential(input: {
        appId: AppId;
        providerId: ModelCredentialProvider;
    }): Promise<ModelCredential | null>;
    getConfiguredModelProviders(input: {
        appId: AppId;
    }): Promise<Set<string>>;
    private publishAudit;
}
export declare function fingerprintCredential(value: string): string;
export declare function fingerprintCredentialPayload(payload: ModelCredentialPayload): string;
export {};
