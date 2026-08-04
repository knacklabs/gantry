export declare const RUNTIME_ENV_ASSIGNMENT_KEYS: Set<string>;
export declare function stripRuntimeEnvPrefix(command: string): {
    command: string;
    envAssignments: string[];
};
export declare function stripHostInjectedEnvPrefix(command: string): {
    command: string;
    strippedAssignments: string[];
};
