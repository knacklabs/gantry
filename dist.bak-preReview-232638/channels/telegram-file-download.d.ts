export declare const TELEGRAM_MAX_DOWNLOAD_BYTES: number;
export interface TelegramDownloadResponse {
    body?: {
        getReader?: () => {
            read: () => Promise<{
                done: boolean;
                value?: Uint8Array;
            }>;
        };
    } | null;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    headers?: {
        get: (name: string) => string | null;
    };
}
export declare function writeTelegramFetchResponseToFile(response: TelegramDownloadResponse, workspaceRoot: string, filename: string): Promise<string | null>;
