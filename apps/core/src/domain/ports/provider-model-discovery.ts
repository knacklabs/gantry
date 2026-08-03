import type { ModelCredentialPayload } from '../../shared/model-provider-registry.js';

export interface DiscoveredProviderModel {
  providerModelId: string;
  displayName: string;
  deprecated: boolean;
}

export interface ProviderModelDiscoveryPort {
  discover(input: {
    providerId: string;
    authMode: string;
    credential: ModelCredentialPayload;
    signal?: AbortSignal;
  }): Promise<DiscoveredProviderModel[]>;
}
