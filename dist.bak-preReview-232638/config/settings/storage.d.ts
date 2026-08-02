export interface RuntimeStorageConfig {
    postgresUrlEnv: string;
    postgresUrl: string | null;
    postgresSchema: string;
    postgresPlaintextHostAllowlist?: readonly string[];
}
export declare function resolveRuntimeStorageConfig(gantryHome: string, _runtimeRoot: string): RuntimeStorageConfig;
export declare function resolveRuntimeBootstrapStorageConfigFromEnv(): RuntimeStorageConfig | null;
export declare function resolveRuntimeStorageConfigFromSettings(settings: {
    postgresUrlEnv?: string;
    postgresSchema?: string;
}): RuntimeStorageConfig;
