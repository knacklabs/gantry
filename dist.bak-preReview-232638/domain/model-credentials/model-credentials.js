import { listExecutableModelProviders, normalizeModelProviderId, } from '../../shared/model-provider-registry.js';
export function listSupportedModelCredentialProviders() {
    return listExecutableModelProviders()
        .map((provider) => provider.id)
        .sort();
}
export function assertSupportedModelCredentialProvider(providerId) {
    if (!listSupportedModelCredentialProviders().includes(providerId)) {
        throw new Error(`Model credential provider must be one of ${listSupportedModelCredentialProviders().join(', ')}.`);
    }
}
export function normalizeModelCredentialProvider(providerId) {
    return normalizeModelProviderId(providerId);
}
