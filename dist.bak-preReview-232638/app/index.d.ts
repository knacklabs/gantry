import type { HostnameLookup } from '../domain/network/public-address-policy.js';
export { escapeXml, formatMessages } from '../messaging/router.js';
export { getAvailableGroups, _setConversationRoutes, } from './bootstrap/runtime-app.js';
export interface StartGantryRuntimeOptions {
    skipPreflight?: boolean;
    mcpHostnameLookup?: HostnameLookup;
}
export declare function startGantryRuntime(options?: StartGantryRuntimeOptions): Promise<void>;
