import type { parseConfiguredAgents } from './runtime-settings-agents-parser.js';
import type { RuntimeConfiguredBinding, RuntimeConfiguredConversation, RuntimeProviderAccountSettings, RuntimeSettings } from './runtime-settings-types.js';
export declare function deriveAgentBindingsFromDesiredState(input: {
    agents: ReturnType<typeof parseConfiguredAgents>;
    providerAccounts: Record<string, RuntimeProviderAccountSettings>;
    conversations: Record<string, RuntimeConfiguredConversation>;
    bindings: Record<string, RuntimeConfiguredBinding>;
    jidForConversation(conversation: RuntimeConfiguredConversation): string;
}): ReturnType<typeof parseConfiguredAgents>;
export declare function deriveBindingsFromConversationInstalls(conversations: Record<string, RuntimeConfiguredConversation>): Record<string, RuntimeConfiguredBinding>;
export declare function flattenConversationInstalls(conversations: Record<string, RuntimeConfiguredConversation>): RuntimeSettings['conversationInstalls'];
