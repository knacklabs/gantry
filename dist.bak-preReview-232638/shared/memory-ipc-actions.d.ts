export declare const MEMORY_IPC_ACTIONS_BY_TOOL_NAME: {
    readonly memory_search: "memory_search";
    readonly memory_save: "memory_save";
    readonly brain_search: "brain_search";
    readonly brain_query: "brain_query";
    readonly brain_write: "brain_write";
    readonly memory_patch: "memory_patch";
    readonly memory_demote: "memory_demote";
    readonly continuity_summary: "continuity_summary";
    readonly memory_consolidate: "memory_consolidate";
    readonly memory_dream: "memory_dream";
    readonly memory_review_pending: "memory_review_pending";
    readonly memory_review_decision: "memory_review_decision";
    readonly procedure_save: "procedure_save";
    readonly procedure_patch: "procedure_patch";
};
export type GantryMemoryIpcAction = (typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME)[keyof typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME];
export declare function normalizeMemoryIpcActions(actions: readonly string[] | undefined): GantryMemoryIpcAction[];
export declare function memoryIpcActionForToolName(toolName: string): GantryMemoryIpcAction | undefined;
export interface MemoryIpcActionSelectionOptions {
    memoryReviewerIsControlApprover?: boolean;
}
export declare function selectedMemoryIpcActionsFromToolRules(configuredTools: readonly string[], options?: MemoryIpcActionSelectionOptions): GantryMemoryIpcAction[];
