const MARKDOWN_FENCE_DELIMITER = /`{3,}/g;
export function escapeMarkdownFenceDelimiters(content) {
    return content.replace(MARKDOWN_FENCE_DELIMITER, (delimiter) => delimiter.split('').join('\\'));
}
