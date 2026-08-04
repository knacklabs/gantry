import '../channels/register-builtins.js';
import type { SenderControlAllowlistConfig } from '../config/settings/control-allowlist.js';
import type { ChatAllowlistEntry, SenderAllowlistConfig } from '../config/settings/sender-allowlist.js';
export type RuntimeSenderProviderAllowlistConfig = SenderAllowlistConfig & {
    conversations?: Record<string, Record<string, ChatAllowlistEntry>>;
};
export type RuntimeSenderAllowlistConfig = Record<string, RuntimeSenderProviderAllowlistConfig>;
export type RuntimeSenderControlProviderAllowlistConfig = SenderControlAllowlistConfig & {
    conversations?: Record<string, Record<string, string[]>>;
};
export type RuntimeSenderControlAllowlistConfig = Record<string, RuntimeSenderControlProviderAllowlistConfig>;
export declare function invalidateSenderAllowlistCache(filePath?: string): void;
export declare function loadSenderAllowlist(settingsPathOverride?: string): RuntimeSenderAllowlistConfig;
export declare function loadSenderControlAllowlist(settingsPathOverride?: string): RuntimeSenderControlAllowlistConfig;
export declare function isSenderAllowed(chatJid: string, sender: string, cfg: RuntimeSenderAllowlistConfig, agentFolder?: string): boolean;
export declare function isSenderExplicitlyAllowed(chatJid: string, sender: string, cfg: RuntimeSenderAllowlistConfig, agentFolder?: string): boolean;
export declare function isSenderControlAllowed(chatJid: string, sender: string, cfg: RuntimeSenderControlAllowlistConfig, agentFolder?: string): boolean;
export declare function shouldDropMessage(chatJid: string, cfg: RuntimeSenderAllowlistConfig, agentFolder?: string): boolean;
export declare function isTriggerAllowed(chatJid: string, sender: string, cfg: RuntimeSenderAllowlistConfig, agentFolder?: string): boolean;
export declare function shouldLogDenied(chatJid: string, cfg: RuntimeSenderAllowlistConfig): boolean;
