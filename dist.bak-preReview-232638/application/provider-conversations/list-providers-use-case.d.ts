import type { Provider } from '../../domain/provider/provider.js';
import type { ProviderCatalogPort } from './provider-catalog-ports.js';
export declare class ListProvidersUseCase {
    private readonly providers;
    constructor(providers: ProviderCatalogPort);
    execute(): Promise<{
        providers: Provider[];
    }>;
}
