export declare function createInlineToolSuccessLedger(): {
    recordSuccess: (toolName: string) => Set<string>;
    hasSuccess: (toolName: string) => boolean;
};
