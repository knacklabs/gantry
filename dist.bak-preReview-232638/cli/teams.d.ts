import '../channels/register-builtins.js';
import type { TeamsSetupDiscoveryClient } from '../channels/teams-setup-discovery.js';
export declare function registerTeamsMainGroup(options: {
    runtimeHome: string;
    chatJid: string;
    displayName: string;
    agentId?: string;
}): Promise<{
    folder: string;
    groupName: string;
}>;
export declare function runTeamsConnectCommand(runtimeHome: string, discoveryClient?: TeamsSetupDiscoveryClient, requestedAgentId?: string, requestedAgentName?: string): Promise<number>;
