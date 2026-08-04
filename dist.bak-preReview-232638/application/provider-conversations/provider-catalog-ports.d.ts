import type { Provider } from '../../domain/provider/provider.js';
export interface ProviderCatalogPort {
    listProviders(): Promise<Provider[]> | Provider[];
}
