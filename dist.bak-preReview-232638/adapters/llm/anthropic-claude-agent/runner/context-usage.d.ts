export declare function readContextUsage(queryHandle: unknown): Promise<{
    totalTokens: number;
    maxTokens: number;
    percentage: number;
    model: string | undefined;
    categories: {
        name: string;
        tokens: number;
        percentage: number | undefined;
    }[];
    apiUsage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
    } | null | undefined;
    at: string;
} | undefined>;
