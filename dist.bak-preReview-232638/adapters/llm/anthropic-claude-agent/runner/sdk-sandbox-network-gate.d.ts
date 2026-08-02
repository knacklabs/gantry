export declare function decideSdkSandboxNetworkAccess(input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    denylist: readonly string[];
}): Promise<{
    behavior: 'allow';
    updatedInput: Record<string, unknown>;
} | {
    behavior: 'deny';
    message: string;
    interrupt: false;
} | null>;
