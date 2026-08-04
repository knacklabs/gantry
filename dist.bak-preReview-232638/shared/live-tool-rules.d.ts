export declare function readLiveToolRules(input: {
    ipcDir?: string;
    runHandle?: string;
}): string[];
export declare function appendLiveToolRules(input: {
    ipcDir?: string;
    runHandle?: string;
    rules: readonly string[];
}): string[];
export declare function removeLiveToolRules(input: {
    ipcDir?: string;
    runHandle?: string;
    rules: readonly string[];
}): string[];
