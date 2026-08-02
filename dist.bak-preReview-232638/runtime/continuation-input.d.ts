export declare function getContinuationInputNamespace(threadId?: string | null): string;
export declare function taskContinuationThreadId(threadId: string | null | undefined, parentTaskId: string | null | undefined): string | null | undefined;
export declare function getContinuationInputDir(workspaceFolder: string, threadId?: string | null): string;
export declare function continuationInputPath(workspaceFolder: string, sequence: number | string, threadId?: string | null): string;
export declare function closeSignalPath(workspaceFolder: string, threadId?: string | null): string;
export declare function writeContinuationInput(workspaceFolder: string, text: string, sequence: number | string, threadId?: string | null): void;
export declare function writeCloseSignal(workspaceFolder: string, threadId?: string | null): void;
