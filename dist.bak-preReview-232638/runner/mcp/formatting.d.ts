export declare function formatMemoryToolResponse(response: {
    provider?: string;
    data?: unknown;
}): string;
export declare function formatMemoryReviewPendingResponse(response: {
    provider?: string;
    data?: unknown;
}): string;
export declare function formatMemoryReviewDecisionResponse(response: {
    provider?: string;
    data?: unknown;
}): string;
export declare function formatBrainSearchResponse(response: {
    provider?: string;
    data?: unknown;
}): string;
export declare function formatBrainQueryResponse(response: {
    provider?: string;
    data?: unknown;
}): string;
export declare function formatBrainWriteResponse(response: {
    provider?: string;
    data?: unknown;
}): string;
/**
 * Concise human-readable acknowledgement for memory WRITE actions
 * (save/patch/demote/procedure/consolidate/dream). Avoids dumping the raw
 * provider JSON / internal ids. Read actions (memory_search, continuity_summary)
 * must NOT use this — the agent consumes their full data.
 */
export declare function formatMemoryWriteResponse(action: string, response: {
    provider?: string;
    data?: unknown;
}): string;
export declare function formatBrowserToolResponse(response: {
    data?: unknown;
}): string;
export declare function truncateText(value: string, maxLength: number): string;
export declare function formatTaskFailureLines(response: {
    code?: string;
    details?: string[];
    error?: string;
}, fallbackError: string): string[];
