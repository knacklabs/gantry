export declare const TOKEN_BOUND_HTTP_GUIDANCE = "Check token scopes, chat permissions, and network, then retry. Raw token-bearing transport details are intentionally not printed.";
export declare const TOKEN_BOUND_NETWORK_GUIDANCE = "Check internet access and retry. Raw token-bearing transport details are intentionally not printed.";
export declare function safeSlackErrorCode(error: unknown): string;
export declare function safeTelegramDescription(description: unknown, fallback: string): string;
