interface MemoryBoundaryPermissionOpts {
    title?: string;
    displayName?: string;
    description?: string;
    decisionReason?: string;
    blockedPath?: string;
}
export declare function composeSystemPromptAppend(compiledPrompt: string | undefined, hasMemoryContext: boolean): string | undefined;
export declare function denyMemoryBoundaryToolUse(toolName: string, input: unknown, permissionOpts: MemoryBoundaryPermissionOpts, memoryBlock: string, isThirdPartyMcpTool?: boolean): string | null;
export {};
