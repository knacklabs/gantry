export declare function channelProgressStateFilePath(channel: string, token: string): string | null;
export declare function readProgressStateEntries(filePath: string | null, channel: string): Array<[string, Record<string, unknown>]>;
export declare function writeProgressStateEntries(filePath: string | null, channel: string, entries: Iterable<[string, unknown]>): void;
