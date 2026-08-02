import type { AppId } from '../app/app.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
export type CapabilitySecretId = BrandedId<'CapabilitySecretId'>;
export interface CapabilitySecretMetadata {
    id: CapabilitySecretId;
    appId: AppId;
    name: string;
    allowedCapabilityIds: string[];
    createdBy?: string;
    updatedBy?: string;
    createdAt: IsoTimestamp;
    updatedAt: IsoTimestamp;
}
export interface CapabilitySecret extends CapabilitySecretMetadata {
    value: string;
}
export declare function normalizeCapabilitySecretName(name: string): string;
export declare function assertValidCapabilitySecretName(name: string): void;
export declare function redactCapabilitySecretValue(_value?: string): string;
