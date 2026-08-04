import { HumanMessage } from '@langchain/core/messages';
export const MAX_CACHE_CONTROL_BREAKPOINTS = 4;
const CACHE_CONTROL_EPHEMERAL = { type: 'ephemeral' };
export function parseCachePromptControlMode(value) {
    const mode = value?.trim().toLowerCase();
    if (mode === 'explicit' || mode === 'automatic' || mode === 'none') {
        return mode;
    }
    // Fail safe: anything unrecognized injects nothing (no spurious breakpoints).
    return 'none';
}
// Pure transform over the turn messages. Returns the SAME array reference when
// the mode injects nothing (automatic/none), or a new array with cache_control
// breakpoints on the leading stable prefix messages when 'explicit'.
export function applyCachePromptControl(messages, mode) {
    if (mode !== 'explicit')
        return messages;
    if (messages.length === 0)
        return messages;
    // Breakpoint the leading stable prefix: the durable-memory-context block (the
    // last leading HumanMessage carrying the <gantry_memory_context> framing) and
    // the first turn message. We mark from the front up to the cap.
    let remaining = MAX_CACHE_CONTROL_BREAKPOINTS;
    const next = messages.map((message, index) => {
        if (remaining <= 0)
            return message;
        // Breakpoint only the leading prefix messages (index 0 and any leading
        // memory-block HumanMessage at index 1) — the stable prompt prefix.
        if (index > 1)
            return message;
        remaining -= 1;
        return withCacheControlBreakpoint(message);
    });
    return next;
}
// Converts a message's content to a single text content part carrying
// cache_control. String content becomes `[{type:'text', text, cache_control}]`;
// an existing content-part array gets cache_control on its LAST text part (one
// breakpoint per message). Non-text / empty content is returned unchanged.
function withCacheControlBreakpoint(message) {
    const content = message.content;
    if (typeof content === 'string') {
        if (content.length === 0)
            return message;
        return cloneWithContent(message, [
            { type: 'text', text: content, cache_control: CACHE_CONTROL_EPHEMERAL },
        ]);
    }
    if (Array.isArray(content)) {
        let marked = false;
        const parts = [...content];
        for (let i = parts.length - 1; i >= 0; i -= 1) {
            const part = parts[i];
            if (part &&
                typeof part === 'object' &&
                part.type === 'text') {
                parts[i] = {
                    ...part,
                    cache_control: CACHE_CONTROL_EPHEMERAL,
                };
                marked = true;
                break;
            }
        }
        if (!marked)
            return message;
        return cloneWithContent(message, parts);
    }
    return message;
}
function cloneWithContent(message, content) {
    // Only HumanMessage prefixes are breakpointed in this lane; preserve the type.
    if (HumanMessage.isInstance(message)) {
        return new HumanMessage({
            content: content,
            additional_kwargs: message.additional_kwargs,
        });
    }
    return message;
}
