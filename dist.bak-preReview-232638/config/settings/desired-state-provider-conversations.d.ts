import type { Conversation } from '../../domain/conversation/conversation.js';
import type { RuntimeConfiguredConversation, RuntimeProviderAccountSettings, RuntimeSettings } from './runtime-settings-types.js';
export interface SettingsProviderJidInfo {
    id: string;
    label: string;
    jidPrefix: string;
    isGroupJid(jid: string): boolean;
}
export declare function providerInfoForJid(jid: string): SettingsProviderJidInfo | undefined;
export declare function stripProviderPrefix(jid: string): string;
export declare function jidForConfiguredConversation(conversation: RuntimeConfiguredConversation, providerAccounts: Record<string, RuntimeProviderAccountSettings>): string;
export declare function configuredConversationKind(kind: RuntimeConfiguredConversation['kind']): Conversation['kind'];
export declare function defaultRuntimeSecretRefs(providerId: string): Record<string, string>;
export declare function providerTopology(settings: RuntimeSettings): Record<string, unknown>;
