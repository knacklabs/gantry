export class ListProvidersUseCase {
    providers;
    constructor(providers) {
        this.providers = providers;
    }
    async execute() {
        return { providers: await this.providers.listProviders() };
    }
}
