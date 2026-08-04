const LIVE_SEND_SEGMENT_MAX_CHARS = 8_000;
export function splitLiveSendProfileText(text) {
    if (!text)
        return [''];
    const segments = [];
    for (let offset = 0; offset < text.length; offset += LIVE_SEND_SEGMENT_MAX_CHARS) {
        segments.push(text.slice(offset, offset + LIVE_SEND_SEGMENT_MAX_CHARS));
    }
    return segments;
}
