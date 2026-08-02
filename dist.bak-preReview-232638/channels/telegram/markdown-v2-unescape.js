const TELEGRAM_ESCAPED_MARKDOWN_V2_CHAR_PATTERN = /\\([_*~[\]()`>#+\-=|{}.!\\])/g;
export function unescapeTelegramEscapedMarkdownV2(text) {
    if (!text)
        return text;
    return text.replace(TELEGRAM_ESCAPED_MARKDOWN_V2_CHAR_PATTERN, '$1');
}
