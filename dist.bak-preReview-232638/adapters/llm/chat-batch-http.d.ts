export declare const CHAT_BATCH_RESULT_LIMIT_BYTES: number;
export declare const CHAT_BATCH_RESULT_LIMIT_ROWS = 100000;
export interface ChatBatchJsonlBudget {
    bytesRead: number;
    rowsRead: number;
}
export declare function assertChatBatchUploadSize(body: string, provider: string): void;
export declare function fetchBatchJson<T>(input: {
    provider: string;
    operation: string;
    url: string;
    init?: RequestInit;
    signal?: AbortSignal;
}): Promise<T>;
export declare function fetchBatchJsonl(input: {
    provider: string;
    operation: string;
    url: string;
    init?: RequestInit;
    signal?: AbortSignal;
    maxBytes?: number;
    maxRows?: number;
    budget?: ChatBatchJsonlBudget;
}): Promise<unknown[]>;
export declare function estimateChatBatchCostUsd(model: string, usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}): number | null;
export declare function finiteNumber(value: unknown): number | undefined;
