export declare function escapeTelegramMarkdownV2Plain(text: string): string;
export declare function escapeTelegramMarkdownV2Literal(text: string): string;
export declare function escapeTelegramMarkdownV2CodeSegment(segment: string): string;
export declare function escapeTelegramMarkdownV2LinkSegment(segment: string): string;
type EscapeTelegramMarkdownV2Options = {
    preserveStyleMarkers?: boolean;
};
/**
 * Escape text for Telegram MarkdownV2 while preserving markdown formatting
 * markers produced by parseTextStyles (bold/italic/strikethrough/links/code).
 */
export declare function escapeTelegramMarkdownV2(text: string, options?: EscapeTelegramMarkdownV2Options): string;
export {};
