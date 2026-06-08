import type { AppId } from '../app/app.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import {
  listExecutableModelProviders,
  normalizeModelProviderId,
  type ModelCredentialPayload,
  type ModelProviderId,
} from '../../shared/model-provider-registry.js';

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

export function listSupportedModelCredentialProviders(): ModelCredentialProvider[] {
  return listExecutableModelProviders()
    .map((provider) => provider.id as ModelCredentialProvider)
    .sort();
}

export function assertSupportedModelCredentialProvider(
  providerId: string,
): asserts providerId is ModelCredentialProvider {
  if (
    !listSupportedModelCredentialProviders().includes(
      providerId as ModelCredentialProvider,
    )
  ) {
    throw new Error(
      `Model credential provider must be one of ${listSupportedModelCredentialProviders().join(', ')}.`,
    );
  }
}

export function normalizeModelCredentialProvider(
  providerId: string,
): ModelCredentialProvider {
  return normalizeModelProviderId(providerId) as ModelCredentialProvider;
}
