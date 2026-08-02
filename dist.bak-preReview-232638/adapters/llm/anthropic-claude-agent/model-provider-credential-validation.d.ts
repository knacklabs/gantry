import type { AgentCredentialInjection } from '../../../domain/models/credentials.js';
import type { ModelCatalogEntry } from '../../../shared/model-catalog.js';
export declare function validateModelCredentialProjectionForEntry(input: {
    model: ModelCatalogEntry;
    projection: Pick<AgentCredentialInjection, 'env' | 'credentialProviders'> & {
        brokerProfile?: string;
    };
}): void;
