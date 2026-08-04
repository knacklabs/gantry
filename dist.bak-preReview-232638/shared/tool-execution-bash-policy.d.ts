export declare function commandText(input: unknown): string | undefined;
export declare function isProviderMcpMutationCommand(command: string): boolean;
export declare function hasBashMutationVerb(command: string): boolean;
export declare function hasBashRedirect(command: string): boolean;
export declare function inferBashTarget(command: string): string | undefined;
export declare function inferBashMutationTargets(command: string): string[];
export declare function isSafeProtectedPathTextPayloadCommand(command: string): boolean;
export declare function hasProtectedPathInGhTextPayloadCommand(command: string): boolean;
