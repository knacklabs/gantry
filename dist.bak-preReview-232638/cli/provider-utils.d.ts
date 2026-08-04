import '../channels/register-builtins.js';
export type RuntimeProviderId = string;
export declare function getProviderIds(): RuntimeProviderId[];
export declare function parseRuntimeProvider(raw: string): RuntimeProviderId | null;
export declare function providerFromGroupJid(jid: string): RuntimeProviderId | null;
export declare function option(args: string[], name: string): string;
export declare function parseRuntimeSecretRefOptions(args: string[]): Record<string, string>;
export declare function assertRuntimeSecretRef(value: string): void;
export declare function providerAccountIdForAgent(settings: {
    providerAccounts: Record<string, {
        provider: string;
        agentId: string;
    }>;
}, input: {
    providerId: string;
    agentId: string;
    defaultAccountId: string;
}): string;
interface ConversationIdSettings {
    providerAccounts: Record<string, {
        provider: string;
    }>;
    conversations: Record<string, {
        externalId: string;
        providerAccount?: string;
        providerConnection?: string;
    }>;
}
export declare function storedConversationIdCandidates(resolvedConversationId: string, providerAccountId: string): string[];
export declare function conversationIdFromConfigured(settings: ConversationIdSettings, configured: ConversationIdSettings['conversations'][string]): string;
export declare function soleProviderAccountIdForJid(settings: Pick<ConversationIdSettings, 'providerAccounts'>, jid: string): string | undefined;
export {};
