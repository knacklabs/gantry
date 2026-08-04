import type { ProviderConversationDiscoveryPort, DiscoveredConversation } from '../application/provider-conversations/provider-conversation-control-use-cases.js';
import type { ProviderCatalogPort } from '../application/provider-conversations/provider-catalog-ports.js';
import type { Provider } from '../domain/provider/provider.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import { type TeamsSetupDiscoveryClient } from './teams-setup-discovery.js';
import { type DiscordSetupDiscoveryClient } from './discord-setup-discovery.js';
import './register-builtins.js';
export declare class BuiltInControlChannelProviderCatalog implements ProviderCatalogPort {
    listProviders(): Provider[];
}
export declare class RuntimeSecretConversationDiscovery implements ProviderConversationDiscoveryPort {
    private readonly secrets;
    private readonly teamsDiscoveryClient;
    private readonly discordDiscoveryClient;
    constructor(secrets: RuntimeSecretProvider, teamsDiscoveryClient?: TeamsSetupDiscoveryClient, discordDiscoveryClient?: DiscordSetupDiscoveryClient);
    discover(input: Parameters<ProviderConversationDiscoveryPort['discover']>[0]): Promise<DiscoveredConversation[]>;
    private resolveSecret;
    private resolveExactSecret;
}
