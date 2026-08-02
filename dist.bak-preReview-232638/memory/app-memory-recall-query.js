const MAX_RECALL_QUERY_CHARS = 1200;
const MAX_RECALL_QUERY_TERMS = 80;
export function buildMemoryRecallQueryFromMessages(messages) {
    return buildBoundedMemoryRecallQuery(messages
        .flatMap((message) => [
        message.reply_to_message_content || '',
        message.content || '',
    ])
        .join('\n'));
}
export function buildBoundedMemoryRecallQuery(input) {
    const cleaned = cleanRecallQueryText(input);
    if (!cleaned)
        return undefined;
    const terms = cleaned
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, MAX_RECALL_QUERY_TERMS);
    const bounded = terms.join(' ').slice(0, MAX_RECALL_QUERY_CHARS).trim();
    return bounded || undefined;
}
function cleanRecallQueryText(input) {
    const raw = input?.trim();
    if (!raw || raw.startsWith('__system:'))
        return '';
    const withoutMarkup = decodeXmlEntities(raw)
        .replace(/<\s*context\b[^>]*\/?\s*>/gi, ' ')
        .replace(/<\s*\/?\s*messages\b[^>]*>/gi, ' ')
        .replace(/<\s*\/?\s*message\b[^>]*>/gi, ' ')
        .replace(/<\s*\/?\s*quoted_message\b[^>]*>/gi, ' ')
        .replace(/<\s*\/?\s*gantry[_a-z0-9-]*\b[^>]*>/gi, ' ')
        .replace(/<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[^<>]{0,500})?>/g, ' ');
    return replaceControlCharacters(withoutMarkup)
        .replace(/\b(?:trust|schema|policy|timezone)\s*=\s*"[^"]*"/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function replaceControlCharacters(value) {
    return Array.from(value, (character) => isControlCharacter(character) ? ' ' : character).join('');
}
function isControlCharacter(value) {
    const code = value.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
}
function decodeXmlEntities(value) {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}
