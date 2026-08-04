import { ChannelFactory } from './channel-provider.js';
export interface ChannelProviderSetupContext {
    runtimeHome: string;
    agentId?: string;
    agentName?: string;
    prompt: (question: string) => Promise<string>;
    confirm: (question: string) => Promise<boolean>;
}
export interface ChannelProviderSetup {
    envKeys: readonly string[];
    describe: () => string;
    run: (ctx: ChannelProviderSetupContext) => Promise<void>;
}
export interface ChannelProviderSettingsLike {
    providers?: Record<string, {
        enabled: boolean;
    }>;
}
export type ChannelFormattingDialect = 'none' | 'markdown-native' | 'mrkdwn' | 'telegram-html' | 'telegram-markdown-v2';
export interface PromptPresentationDescriptor {
    label: string;
    formattingDescription: string;
    maxMessageGuidance?: string;
    attachmentGuidance: string;
}
export interface Provider {
    id: string;
    label: string;
    internal?: boolean;
    controlCapabilityFlags?: readonly string[];
    jidPrefix: string;
    folderPrefix: string;
    isGroupJid: (jid: string) => boolean;
    canStreamToJid?: (jid: string) => boolean;
    formatting: ChannelFormattingDialect;
    promptPresentation?: PromptPresentationDescriptor;
    isEnabled: (settings: ChannelProviderSettingsLike) => boolean;
    create: ChannelFactory;
    setup: ChannelProviderSetup;
}
export declare function registerProvider(provider: Provider): void;
export declare function getProvider(id: string): Provider | undefined;
export declare function normalizeProviderId(id: string): string;
/** Provider-account id the internal control channel registers under. */
export declare function internalControlProviderAccountId(appId: string): string;
/**
 * Fallback provider-account id for a conversation whose message carried none.
 * Internal providers (app: JIDs) have exactly one always-connected channel
 * bound as control:<appId>; minting any other synthetic id there orphans the
 * conversation from channel ownership and its turns are silently skipped.
 */
export declare function fallbackProviderAccountId(appId: string, providerId: string): string;
export declare function providerJidPrefix(providerId: string): string;
export declare function listChannelProviders(): readonly Provider[];
export declare function listConnectableChannelProviders(): readonly Provider[];
export declare function providerForJid(jid: string): Provider | undefined;
export declare function renderChannelPromptPresentation(chatJid: string | undefined, conversationKind: 'dm' | 'channel' | undefined): string | undefined;
export declare function providerIdForJid(jid: string, fallback?: string): string;
