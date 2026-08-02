export interface SseFrameSplitter {
    push: (chunk: Buffer) => string[];
    flush: () => string[];
    overflowed: () => boolean;
    takePending: () => string;
}
export declare const MAX_PENDING_CHARS = 1048576;
export declare function createSseFrameSplitter(): SseFrameSplitter;
export declare function sseFrameData(frame: string): string | undefined;
export declare function isOpenAiUsageOnlyFrame(frame: string): boolean;
