/**
 * parseTextStyles — convert agent Markdown output to channel-native formatting.
 *
 * Code blocks (fenced and inline) are preserved exactly. Marker substitution is
 * applied only to non-code segments.
 */
declare const CHANNEL_DIALECT_PREFIX: "telegram-";
type ChannelFormattingDialect = `${typeof CHANNEL_DIALECT_PREFIX}${'html' | 'markdown-v2'}`;
export type FormattingDialect = 'none' | 'markdown-native' | 'mrkdwn' | ChannelFormattingDialect;
/** Transform Markdown text for the target channel's native format. */
export declare function parseTextStyles(text: string, channel: FormattingDialect): string;
export {};
