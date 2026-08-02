import { CHANNEL_STREAM_UPDATE_INTERVAL_MS } from '../channel-provider.js';
export const SLACK_STREAM_UPDATE_INTERVAL_MS = CHANNEL_STREAM_UPDATE_INTERVAL_MS.slack;
export const SLACK_FALLBACK_CHUNK_MAX_LENGTH = 4000;
export const SLACK_NATIVE_APPEND_MAX_LENGTH = 12000;
export function splitSlackTextByCodeUnits(text, maxCodeUnits) {
    if (!text)
        return [];
    if (text.length <= maxCodeUnits)
        return [text];
    const chunks = [];
    let chunkStart = 0;
    let chunkLength = 0;
    for (const codePoint of text) {
        const codePointLength = codePoint.length;
        if (chunkLength > 0 && chunkLength + codePointLength > maxCodeUnits) {
            chunks.push(text.slice(chunkStart, chunkStart + chunkLength));
            chunkStart += chunkLength;
            chunkLength = 0;
        }
        chunkLength += codePointLength;
    }
    if (chunkStart < text.length) {
        chunks.push(text.slice(chunkStart));
    }
    return chunks;
}
