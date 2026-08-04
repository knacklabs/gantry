export type LlmPassthroughEndpoint = 'messages' | 'count_tokens' | 'chat_completions';
export type UnsupportedLlmRequestField = {
    field: string;
    message: string;
    code?: 'MAX_TOKENS_EXCEEDED';
    limit?: number;
    requested?: number;
    toolType?: string;
    value?: string;
};
export declare function findUnsupportedLlmRequestField(endpoint: LlmPassthroughEndpoint, body: Record<string, unknown>, maxTokens?: number): UnsupportedLlmRequestField | null;
