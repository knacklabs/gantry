import { ChannelOwnershipPort, NewMessage } from '../domain/types.js';
import '../channels/register-builtins.js';
export interface ConversationContextMessages {
    recentChannelContext: NewMessage[];
    activeThreadContext: NewMessage[];
    currentMessages: NewMessage[];
}
export declare const CONVERSATION_CONTEXT_RENDER_LIMITS: {
    readonly messageContentBytes: 1500;
    readonly quotedMessageContentBytes: 300;
    readonly renderedMessageBytes: 6000;
    readonly renderedContextBytes: 16000;
    readonly attributeBytes: 160;
    readonly attachmentsPerMessage: 4;
};
export declare function escapeXml(s: string): string;
export declare function formatMessages(messages: NewMessage[], timezone: string): string;
export declare function formatConversationContextMessages(context: ConversationContextMessages, timezone: string): string;
export declare function stripInternalTags(text: string): string;
export declare function stripInternalTagsPreserveWhitespace(text: string): string;
export declare function formatOutboundForChannel(rawText: string, channelId?: string): string;
export declare function findChannel<T extends ChannelOwnershipPort>(channels: T[], jid: string): T | undefined;
