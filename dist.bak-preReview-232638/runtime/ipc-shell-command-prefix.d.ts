/**
 * For shell tools, strip only the exact prefix authenticated by the runner.
 * Missing or mismatched provenance leaves the command unchanged.
 */
export declare function stripShellCommandEnvPrefix(toolName: string, toolInput: unknown, hostInjectedCommandPrefix?: string): unknown;
