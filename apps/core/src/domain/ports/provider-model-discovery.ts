import type { ModelCredentialPayload } from '../../shared/model-provider-registry.js';
import type { ModelWorkload } from '../../shared/model-catalog.js';

export interface DiscoveredProviderModel {
  providerModelId: string;
  displayName: string;
  deprecated: boolean;
  supportedWorkloads: readonly ModelWorkload[];
}

export interface ProviderModelDiscoveryPort {
  discover(input: {
    providerId: string;
    authMode: string;
    credential: ModelCredentialPayload;
    signal?: AbortSignal;
  }): Promise<DiscoveredProviderModel[]>;
}
