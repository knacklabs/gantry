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

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function normalizeCapabilitySecretName(name: string): string {
  return name.trim().toUpperCase();
}

export function assertValidCapabilitySecretName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(
      'Secret name must be an environment variable name using A-Z, 0-9, and underscore, and must start with A-Z or underscore.',
    );
  }
}

export function redactCapabilitySecretValue(_value?: string): string {
  return '<redacted>';
}
