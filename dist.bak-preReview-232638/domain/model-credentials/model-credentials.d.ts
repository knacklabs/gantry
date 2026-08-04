import type { AppId } from '../app/app.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import { type ModelCredentialPayload, type ModelProviderId } from '../../shared/model-provider-registry.js';
export type ModelCredentialId = BrandedId<'ModelCredentialId'>;
export type ModelCredentialProvider = ModelProviderId;
export type ModelCredentialStatus = 'active' | 'disabled';
export interface ModelCredentialFieldFingerprint {
    field: string;
    fingerprint: string;
}
export interface ModelCredentialMetadata {
    id: ModelCredentialId;
    appId: AppId;
    providerId: ModelCredentialProvider;
    authMode: string;
    status: ModelCredentialStatus;
    schemaVersion: number;
    fingerprint: string;
    fieldFingerprints: ModelCredentialFieldFingerprint[];
    createdBy?: string;
    updatedBy?: string;
    createdAt: IsoTimestamp;
    updatedAt: IsoTimestamp;
}
export interface ModelCredential extends ModelCredentialMetadata {
    payload: ModelCredentialPayload;
}
export declare function listSupportedModelCredentialProviders(): ModelCredentialProvider[];
export declare function assertSupportedModelCredentialProvider(providerId: string): asserts providerId is ModelCredentialProvider;
export declare function normalizeModelCredentialProvider(providerId: string): ModelCredentialProvider;
