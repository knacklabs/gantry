export declare const SLACK_STREAM_UPDATE_INTERVAL_MS: 550;
export declare const SLACK_FALLBACK_CHUNK_MAX_LENGTH = 4000;
export declare const SLACK_NATIVE_APPEND_MAX_LENGTH = 12000;
export declare function splitSlackTextByCodeUnits(text: string, maxCodeUnits: number): string[];
