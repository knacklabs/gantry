/**
 * Provider-neutral owner / delivery labels for user-facing copy.
 *
 * Maps a Gantry conversation JID (+ optional thread) to the locked, human label
 * strings used by channel-facing prompts and Gantry MCP summaries. JID prefixes
 * mirror the registry's builtInProviderJidPrefixes.
 *
 * Labels are rendering terms only — they carry no authority and never appear as
 * raw transport ids in primary copy.
 */
type ConversationKind = 'dm' | 'channel';
/**
 * Human label for where a message is delivered, thread-aware.
 * e.g. a Telegram topic, a Slack thread, otherwise the parent conversation.
 */
export declare function deliveryLabel(conversationJid: string, threadId: string | null | undefined, conversationKind?: ConversationKind): string;
/**
 * Human label for the conversation that owns a message or job.
 * Always the conversation level, never the thread/topic.
 */
export declare function ownerLabel(conversationJid: string, conversationKind?: ConversationKind): string;
export {};
