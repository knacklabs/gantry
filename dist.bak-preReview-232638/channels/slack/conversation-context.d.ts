import type { App } from '@slack/bolt';
import type { ConversationContextHydrationRequest, ConversationContextHydrationResult } from '../channel-provider.js';
export interface SlackConversationContextDeps {
    app: App | null;
    botUserId: string | null;
    parseJid(jid: string): {
        channelId: string;
    } | null;
    resolveUserName(userId: string | undefined): Promise<string>;
}
export declare function hydrateSlackConversationContext(request: ConversationContextHydrationRequest, deps: SlackConversationContextDeps): Promise<ConversationContextHydrationResult>;
