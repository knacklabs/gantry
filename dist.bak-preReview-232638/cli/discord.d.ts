import '../channels/register-builtins.js';
import type { DiscordSetupDiscoveryClient } from '../channels/discord-setup-discovery.js';
export declare function registerDiscordMainGroup(options: {
    runtimeHome: string;
    chatJid: string;
    displayName: string;
    agentId?: string;
}): Promise<{
    folder: string;
    groupName: string;
}>;
export declare function runDiscordConnectCommand(runtimeHome: string, discoveryClient?: DiscordSetupDiscoveryClient, requestedAgentId?: string, requestedAgentName?: string): Promise<number>;
