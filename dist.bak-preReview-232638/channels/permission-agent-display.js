import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
export function permissionPromptTitle(sourceAgentFolder, label) {
    return `Allow ${formatPermissionAgentDisplayName(sourceAgentFolder)} to use ${label}?`;
}
export function formatPermissionAgentDisplayName(sourceAgentFolder) {
    const sanitized = sanitizeAgentName(sourceAgentFolder);
    if (!sanitized)
        return 'this agent';
    const withoutPrefix = sanitized.replace(/^agent:/i, '');
    const words = withoutPrefix
        .replaceAll(/[_-]+/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
    if (!words)
        return 'this agent';
    return words
        .split(' ')
        .map((word) => /^[A-Z0-9]+$/.test(word)
        ? word
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(' ');
}
function sanitizeAgentName(input) {
    const result = sanitizeOutboundLlmText(input);
    const text = result.blocked ? 'Sensitive detail hidden.' : result.text;
    return headTailTruncate(text, 120, 40).trim();
}
function headTailTruncate(input, head, tail) {
    if (input.length <= head + tail + 1)
        return input;
    return `${input.slice(0, head)}…${input.slice(-tail)}`;
}
